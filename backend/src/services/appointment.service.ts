import { and, eq, gte, ilike, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { appointments, doctorAvailability, doctors, patients } from '../db/schema';

function toDateOnlyString(date: Date) {
    return date.toISOString().split('T')[0];
}

function toTimeString(date: Date) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export class AppointmentService {
    static async getDoctorsBySpecialty(specialty: string) {
        if (!specialty) {
            return db.select().from(doctors);
        }

        return db.select().from(doctors).where(ilike(doctors.specialty, `%${specialty}%`));
    }

    static async getDoctorInfo(doctorId: number) {
        const [doctor] = await db.select().from(doctors).where(eq(doctors.id, doctorId));
        if (!doctor) return null;

        const availability = await db
            .select()
            .from(doctorAvailability)
            .where(eq(doctorAvailability.doctorId, doctorId));

        return { ...doctor, availability };
    }

    private static async getMatchingDoctors(params: { doctorId?: number; specialty?: string }) {
        if (params.doctorId) {
            return db.select().from(doctors).where(eq(doctors.id, params.doctorId));
        }

        if (params.specialty) {
            return db.select().from(doctors).where(ilike(doctors.specialty, `%${params.specialty}%`));
        }

        return db.select().from(doctors);
    }

    private static async getDoctorSlotsForDate(doctorId: number, date: string) {
        const targetDate = new Date(`${date}T00:00:00`);
        const dayOfWeek = targetDate.getDay();
        const now = new Date();
        const isToday = targetDate.toDateString() === now.toDateString();

        const schedules = await db
            .select()
            .from(doctorAvailability)
            .where(and(eq(doctorAvailability.doctorId, doctorId), eq(doctorAvailability.dayOfWeek, dayOfWeek)));

        if (schedules.length === 0) {
            return [];
        }

        const dayStart = new Date(`${date}T00:00:00`);
        const dayEnd = new Date(`${date}T23:59:59`);

        const booked = await db
            .select()
            .from(appointments)
            .where(
                and(
                    eq(appointments.doctorId, doctorId),
                    eq(appointments.status, 'confirmed'),
                    gte(appointments.appointmentAt, dayStart),
                    lte(appointments.appointmentAt, dayEnd),
                ),
            );

        const bookedTimes = new Set(booked.map((item) => toTimeString(new Date(item.appointmentAt))));
        const allSlots: string[] = [];

        for (const schedule of schedules) {
            const [startH, startM] = schedule.startTime.split(':').map(Number);
            const [endH, endM] = schedule.endTime.split(':').map(Number);
            const startMinutes = startH * 60 + startM;
            const endMinutes = endH * 60 + endM;

            for (
                let minutes = startMinutes;
                minutes + schedule.slotDurationMinutes <= endMinutes;
                minutes += schedule.slotDurationMinutes
            ) {
                const hour = Math.floor(minutes / 60);
                const minute = minutes % 60;
                const slot = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

                if (bookedTimes.has(slot)) {
                    continue;
                }

                if (isToday) {
                    const slotTime = new Date(targetDate);
                    slotTime.setHours(hour, minute, 0, 0);
                    if (slotTime <= now) {
                        continue;
                    }
                }

                allSlots.push(slot);
            }
        }

        return allSlots;
    }

    static async checkAvailability(params: { doctorId?: number; specialty?: string; date: string }) {
        const targetDate = new Date(`${params.date}T00:00:00`);
        if (Number.isNaN(targetDate.getTime())) {
            return [];
        }

        const matchingDoctors = await AppointmentService.getMatchingDoctors(params);
        const results = [];

        for (const doctor of matchingDoctors) {
            const availableSlots = await AppointmentService.getDoctorSlotsForDate(doctor.id, params.date);
            if (availableSlots.length === 0) {
                continue;
            }

            results.push({
                doctor: { id: doctor.id, name: doctor.name, specialty: doctor.specialty },
                availableSlots,
            });
        }

        return results;
    }

    static async findAlternativeSlots(params: { doctorId: number; preferredDate: string; windowDays?: number }) {
        const alternatives = [];
        const windowDays = params.windowDays || 7;

        for (let offset = 0; offset < windowDays; offset++) {
            const date = new Date(`${params.preferredDate}T00:00:00`);
            date.setDate(date.getDate() + offset);
            const dateStr = toDateOnlyString(date);

            const slots = await AppointmentService.getDoctorSlotsForDate(params.doctorId, dateStr);
            if (slots.length > 0) {
                alternatives.push({ date: dateStr, slots: slots.slice(0, 5) });
            }
        }

        return alternatives;
    }

    static async bookAppointment(params: {
        patientId: number;
        doctorId: number;
        dateTime: string;
        reason?: string;
        durationMinutes?: number;
        ignoreAppointmentId?: number;
    }) {
        const appointmentTime = new Date(params.dateTime);
        const duration = params.durationMinutes || 30;

        if (Number.isNaN(appointmentTime.getTime())) {
            return { success: false, error: 'Invalid appointment date/time.' };
        }

        if (appointmentTime <= new Date()) {
            return { success: false, error: 'Cannot book appointments in the past.' };
        }

        const [doctor] = await db.select().from(doctors).where(eq(doctors.id, params.doctorId));
        if (!doctor) {
            return { success: false, error: `Doctor with ID ${params.doctorId} not found.` };
        }

        const requestedDate = toDateOnlyString(appointmentTime);
        const requestedSlot = toTimeString(appointmentTime);
        const validSlots = await AppointmentService.getDoctorSlotsForDate(params.doctorId, requestedDate);

        if (!validSlots.includes(requestedSlot)) {
            const alternatives = await AppointmentService.findAlternativeSlots({
                doctorId: params.doctorId,
                preferredDate: requestedDate,
            });

            return {
                success: false,
                error: 'That slot is unavailable for this doctor.',
                alternatives,
            };
        }

        const conflictConditions = [
            eq(appointments.doctorId, params.doctorId),
            eq(appointments.status, 'confirmed'),
            eq(appointments.appointmentAt, appointmentTime),
        ];

        if (params.ignoreAppointmentId) {
            conflictConditions.push(ne(appointments.id, params.ignoreAppointmentId));
        }

        const doctorConflicts = await db.select().from(appointments).where(and(...conflictConditions));
        if (doctorConflicts.length > 0) {
            const alternatives = await AppointmentService.findAlternativeSlots({
                doctorId: params.doctorId,
                preferredDate: requestedDate,
            });

            return {
                success: false,
                error: 'This time slot is already booked.',
                alternatives,
            };
        }

        const patientConflictConditions = [
            eq(appointments.patientId, params.patientId),
            eq(appointments.status, 'confirmed'),
            eq(appointments.appointmentAt, appointmentTime),
        ];

        if (params.ignoreAppointmentId) {
            patientConflictConditions.push(ne(appointments.id, params.ignoreAppointmentId));
        }

        const patientConflicts = await db.select().from(appointments).where(and(...patientConflictConditions));
        if (patientConflicts.length > 0) {
            return {
                success: false,
                error: 'The patient already has another appointment at that time.',
            };
        }

        const [newAppointment] = await db
            .insert(appointments)
            .values({
                patientId: params.patientId,
                doctorId: params.doctorId,
                appointmentAt: appointmentTime,
                durationMinutes: duration,
                status: 'confirmed',
                reason: params.reason || null,
                rescheduledFrom: params.ignoreAppointmentId || null,
            })
            .returning();

        return {
            success: true,
            appointment: {
                id: newAppointment.id,
                doctorName: doctor.name,
                doctorSpecialty: doctor.specialty,
                appointmentAt: newAppointment.appointmentAt,
                reason: newAppointment.reason,
            },
        };
    }

    static async rescheduleAppointment(params: { appointmentId: number; newDateTime: string; patientId: number }) {
        const [existing] = await db.select().from(appointments).where(eq(appointments.id, params.appointmentId));

        if (!existing) {
            return { success: false, error: 'Appointment not found.' };
        }

        if (existing.patientId !== params.patientId) {
            return { success: false, error: 'This appointment does not belong to the specified patient.' };
        }

        if (existing.status !== 'confirmed') {
            return { success: false, error: `Cannot reschedule because appointment is already ${existing.status}.` };
        }

        const result = await AppointmentService.bookAppointment({
            patientId: params.patientId,
            doctorId: existing.doctorId,
            dateTime: params.newDateTime,
            reason: existing.reason || undefined,
            ignoreAppointmentId: params.appointmentId,
        });

        if (!result.success) {
            return result;
        }

        await db
            .update(appointments)
            .set({ status: 'rescheduled', updatedAt: new Date() })
            .where(eq(appointments.id, params.appointmentId));

        return {
            success: true,
            appointment: result.appointment,
            previousAppointmentId: params.appointmentId,
        };
    }

    static async cancelAppointment(params: { appointmentId: number; patientId: number }) {
        const [existing] = await db.select().from(appointments).where(eq(appointments.id, params.appointmentId));

        if (!existing) {
            return { success: false, error: 'Appointment not found.' };
        }

        if (existing.patientId !== params.patientId) {
            return { success: false, error: 'This appointment does not belong to the specified patient.' };
        }

        if (existing.status === 'cancelled') {
            return { success: false, error: 'Appointment is already cancelled.' };
        }

        await db
            .update(appointments)
            .set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() })
            .where(eq(appointments.id, params.appointmentId));

        return { success: true, cancelledAppointmentId: params.appointmentId };
    }

    static async listAppointments(params: { patientId: number; status?: string }) {
        const conditions = [eq(appointments.patientId, params.patientId)];
        if (params.status) {
            conditions.push(eq(appointments.status, params.status));
        }

        return db
            .select({
                id: appointments.id,
                appointmentAt: appointments.appointmentAt,
                status: appointments.status,
                reason: appointments.reason,
                doctorName: doctors.name,
                doctorSpecialty: doctors.specialty,
            })
            .from(appointments)
            .innerJoin(doctors, eq(appointments.doctorId, doctors.id))
            .where(and(...conditions))
            .orderBy(appointments.appointmentAt);
    }

    static async findPatientAppointments(params: {
        patientId: number;
        patientName?: string;
        patientPhone?: string;
        doctorName?: string;
        date?: string;
        status?: string;
        limit?: number;
    }) {
        const conditions = [eq(appointments.patientId, params.patientId)];

        if (params.status) {
            conditions.push(eq(appointments.status, params.status));
        }

        if (params.date) {
            const dayStart = new Date(`${params.date}T00:00:00`);
            const dayEnd = new Date(`${params.date}T23:59:59`);
            if (!Number.isNaN(dayStart.getTime())) {
                conditions.push(gte(appointments.appointmentAt, dayStart));
                conditions.push(lte(appointments.appointmentAt, dayEnd));
            }
        }

        const query = db
            .select({
                id: appointments.id,
                appointmentAt: appointments.appointmentAt,
                status: appointments.status,
                reason: appointments.reason,
                doctorId: appointments.doctorId,
                doctorName: doctors.name,
                doctorSpecialty: doctors.specialty,
            })
            .from(appointments)
            .innerJoin(doctors, eq(appointments.doctorId, doctors.id))
            .where(and(...conditions))
            .orderBy(appointments.appointmentAt)
            .limit(params.limit || 5);

        const rows = await query;

        if (params.doctorName) {
            const normalizedDoctor = params.doctorName.toLowerCase();
            return rows.filter((row) => row.doctorName.toLowerCase().includes(normalizedDoctor));
        }

        return rows;
    }

    static async findOrCreatePatient(params: { name: string; phone?: string; preferredLanguage?: string }) {
        if (params.phone) {
            const [byPhone] = await db.select().from(patients).where(eq(patients.phone, params.phone));
            if (byPhone) {
                if (
                    params.preferredLanguage &&
                    byPhone.preferredLanguage &&
                    byPhone.preferredLanguage !== params.preferredLanguage
                ) {
                    const [updated] = await db
                        .update(patients)
                        .set({ preferredLanguage: params.preferredLanguage })
                        .where(eq(patients.id, byPhone.id))
                        .returning();
                    return updated;
                }

                return byPhone;
            }
        }

        const [byName] = await db.select().from(patients).where(ilike(patients.name, params.name));
        if (byName) {
            return byName;
        }

        const [newPatient] = await db
            .insert(patients)
            .values({
                name: params.name,
                phone: params.phone || null,
                preferredLanguage: params.preferredLanguage || 'en',
            })
            .returning();

        return newPatient;
    }

    static async getPatientContext(patientId: number) {
        const [patient] = await db.select().from(patients).where(eq(patients.id, patientId));
        if (!patient) return null;

        const recentAppointments = await db
            .select({
                id: appointments.id,
                appointmentAt: appointments.appointmentAt,
                status: appointments.status,
                reason: appointments.reason,
                doctorName: doctors.name,
                doctorSpecialty: doctors.specialty,
            })
            .from(appointments)
            .innerJoin(doctors, eq(appointments.doctorId, doctors.id))
            .where(eq(appointments.patientId, patientId))
            .orderBy(sql`${appointments.appointmentAt} DESC`)
            .limit(5);

        return {
            patient: {
                id: patient.id,
                name: patient.name,
                phone: patient.phone,
                preferredLanguage: patient.preferredLanguage,
                notes: patient.notes,
            },
            recentAppointments,
        };
    }
}
