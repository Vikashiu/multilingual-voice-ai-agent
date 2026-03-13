import { eq, and, gte, lte, sql, ilike } from 'drizzle-orm';
import { db } from '../db';
import { doctors, doctorAvailability, patients, appointments } from '../db/schema';

export class AppointmentService {

    // --- DOCTOR QUERIES ---

    static async getDoctorsBySpecialty(specialty: string) {
        if (!specialty) {
            return db.select().from(doctors);
        }
        return db.select().from(doctors)
            .where(ilike(doctors.specialty, `%${specialty}%`));
    }

    static async getDoctorInfo(doctorId: number) {
        const [doctor] = await db.select().from(doctors).where(eq(doctors.id, doctorId));
        if (!doctor) return null;

        const availability = await db.select().from(doctorAvailability)
            .where(eq(doctorAvailability.doctorId, doctorId));

        return { ...doctor, availability };
    }

    // --- AVAILABILITY ---

    static async checkAvailability(params: {
        doctorId?: number;
        specialty?: string;
        date: string; // "YYYY-MM-DD"
    }) {
        const targetDate = new Date(params.date);
        const dayOfWeek = targetDate.getDay(); // 0=Sun, 6=Sat

        // Find matching doctors
        let matchingDoctors;
        if (params.doctorId) {
            matchingDoctors = await db.select().from(doctors)
                .where(eq(doctors.id, params.doctorId));
        } else if (params.specialty) {
            matchingDoctors = await db.select().from(doctors)
                .where(ilike(doctors.specialty, `%${params.specialty}%`));
        } else {
            matchingDoctors = await db.select().from(doctors);
        }

        const results = [];

        for (const doctor of matchingDoctors) {
            // Get schedule for this day of week
            const schedules = await db.select().from(doctorAvailability)
                .where(and(
                    eq(doctorAvailability.doctorId, doctor.id),
                    eq(doctorAvailability.dayOfWeek, dayOfWeek)
                ));

            if (schedules.length === 0) continue; // Doctor doesn't work this day

            // Generate all possible slots
            const allSlots: string[] = [];
            for (const sched of schedules) {
                const [startH, startM] = sched.startTime.split(':').map(Number);
                const [endH, endM] = sched.endTime.split(':').map(Number);
                const startMinutes = startH * 60 + startM;
                const endMinutes = endH * 60 + endM;

                for (let m = startMinutes; m + sched.slotDurationMinutes <= endMinutes; m += sched.slotDurationMinutes) {
                    const h = Math.floor(m / 60);
                    const min = m % 60;
                    allSlots.push(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
                }
            }

            // Get booked appointments for this doctor on this date
            const dayStart = new Date(params.date + 'T00:00:00');
            const dayEnd = new Date(params.date + 'T23:59:59');

            const booked = await db.select().from(appointments)
                .where(and(
                    eq(appointments.doctorId, doctor.id),
                    eq(appointments.status, 'confirmed'),
                    gte(appointments.appointmentAt, dayStart),
                    lte(appointments.appointmentAt, dayEnd)
                ));

            const bookedTimes = new Set(
                booked.map(a => {
                    const d = new Date(a.appointmentAt);
                    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                })
            );

            // Filter out past slots if date is today
            const now = new Date();
            const isToday = targetDate.toDateString() === now.toDateString();

            const availableSlots = allSlots.filter(slot => {
                if (bookedTimes.has(slot)) return false;
                if (isToday) {
                    const [h, m] = slot.split(':').map(Number);
                    const slotTime = new Date(targetDate);
                    slotTime.setHours(h, m, 0, 0);
                    if (slotTime <= now) return false;
                }
                return true;
            });

            results.push({
                doctor: { id: doctor.id, name: doctor.name, specialty: doctor.specialty },
                availableSlots,
            });
        }

        return results;
    }

    static async findAlternativeSlots(params: {
        doctorId: number;
        preferredDate: string;
        windowDays?: number;
    }) {
        const windowDays = params.windowDays || 7;
        const alternatives = [];

        for (let i = 0; i < windowDays; i++) {
            const date = new Date(params.preferredDate);
            date.setDate(date.getDate() + i);
            const dateStr = date.toISOString().split('T')[0];

            const result = await AppointmentService.checkAvailability({
                doctorId: params.doctorId,
                date: dateStr,
            });

            if (result.length > 0 && result[0].availableSlots.length > 0) {
                alternatives.push({
                    date: dateStr,
                    slots: result[0].availableSlots.slice(0, 5), // Limit to 5 per day
                });
            }
        }

        return alternatives;
    }

    // --- BOOKING ---

    static async bookAppointment(params: {
        patientId: number;
        doctorId: number;
        dateTime: string; // ISO "2026-03-15T09:00:00"
        reason?: string;
        durationMinutes?: number;
    }) {
        const appointmentTime = new Date(params.dateTime);
        const duration = params.durationMinutes || 30;

        // Reject past dates
        if (appointmentTime <= new Date()) {
            return { success: false, error: 'Cannot book appointments in the past.' };
        }

        // Check doctor exists
        const [doctor] = await db.select().from(doctors).where(eq(doctors.id, params.doctorId));
        if (!doctor) {
            return { success: false, error: `Doctor with ID ${params.doctorId} not found.` };
        }

        // Check for conflicts
        const conflictWindow = duration * 60 * 1000; // ms
        const windowStart = new Date(appointmentTime.getTime() - conflictWindow + 1);
        const windowEnd = new Date(appointmentTime.getTime() + conflictWindow - 1);

        const conflicts = await db.select().from(appointments)
            .where(and(
                eq(appointments.doctorId, params.doctorId),
                eq(appointments.status, 'confirmed'),
                gte(appointments.appointmentAt, windowStart),
                lte(appointments.appointmentAt, windowEnd)
            ));

        if (conflicts.length > 0) {
            // Find alternatives
            const dateStr = appointmentTime.toISOString().split('T')[0];
            const alternatives = await AppointmentService.checkAvailability({
                doctorId: params.doctorId,
                date: dateStr,
            });

            return {
                success: false,
                error: 'This time slot is already booked.',
                alternatives: alternatives.length > 0 ? alternatives[0].availableSlots.slice(0, 4) : [],
            };
        }

        // Book
        const [newAppointment] = await db.insert(appointments).values({
            patientId: params.patientId,
            doctorId: params.doctorId,
            appointmentAt: appointmentTime,
            durationMinutes: duration,
            status: 'confirmed',
            reason: params.reason || null,
        }).returning();

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

    // --- RESCHEDULE ---

    static async rescheduleAppointment(params: {
        appointmentId: number;
        newDateTime: string;
        patientId: number;
    }) {
        const [existing] = await db.select().from(appointments)
            .where(eq(appointments.id, params.appointmentId));

        if (!existing) {
            return { success: false, error: 'Appointment not found.' };
        }
        if (existing.patientId !== params.patientId) {
            return { success: false, error: 'This appointment does not belong to the specified patient.' };
        }
        if (existing.status !== 'confirmed') {
            return { success: false, error: `Cannot reschedule — appointment is already ${existing.status}.` };
        }

        // Mark old as rescheduled
        await db.update(appointments)
            .set({ status: 'rescheduled', updatedAt: new Date() })
            .where(eq(appointments.id, params.appointmentId));

        // Book new one
        const result = await AppointmentService.bookAppointment({
            patientId: params.patientId,
            doctorId: existing.doctorId,
            dateTime: params.newDateTime,
            reason: existing.reason || undefined,
        });

        if (!result.success) {
            // Revert the old appointment status
            await db.update(appointments)
                .set({ status: 'confirmed', updatedAt: new Date() })
                .where(eq(appointments.id, params.appointmentId));
            return result;
        }

        return {
            success: true,
            appointment: result.appointment,
            previousAppointmentId: params.appointmentId,
        };
    }

    // --- CANCEL ---

    static async cancelAppointment(params: {
        appointmentId: number;
        patientId: number;
    }) {
        const [existing] = await db.select().from(appointments)
            .where(eq(appointments.id, params.appointmentId));

        if (!existing) {
            return { success: false, error: 'Appointment not found.' };
        }
        if (existing.patientId !== params.patientId) {
            return { success: false, error: 'This appointment does not belong to the specified patient.' };
        }
        if (existing.status === 'cancelled') {
            return { success: false, error: 'Appointment is already cancelled.' };
        }

        await db.update(appointments)
            .set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() })
            .where(eq(appointments.id, params.appointmentId));

        return { success: true, cancelledAppointmentId: params.appointmentId };
    }

    // --- LIST ---

    static async listAppointments(params: {
        patientId: number;
        status?: string;
    }) {
        const conditions = [eq(appointments.patientId, params.patientId)];
        if (params.status) {
            conditions.push(eq(appointments.status, params.status));
        }

        const rows = await db.select({
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

        return rows;
    }

    // --- PATIENT RESOLUTION ---

    static async findOrCreatePatient(params: {
        name: string;
        phone?: string;
        preferredLanguage?: string;
    }) {
        // Try phone match first
        if (params.phone) {
            const [byPhone] = await db.select().from(patients)
                .where(eq(patients.phone, params.phone));
            if (byPhone) return byPhone;
        }

        // Try name match
        const [byName] = await db.select().from(patients)
            .where(ilike(patients.name, params.name));
        if (byName) return byName;

        // Create new
        const [newPatient] = await db.insert(patients).values({
            name: params.name,
            phone: params.phone || null,
            preferredLanguage: params.preferredLanguage || 'en',
        }).returning();

        return newPatient;
    }

    // --- PATIENT CONTEXT (for cross-session memory) ---

    static async getPatientContext(patientId: number) {
        const [patient] = await db.select().from(patients)
            .where(eq(patients.id, patientId));
        if (!patient) return null;

        const recentAppointments = await db.select({
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
