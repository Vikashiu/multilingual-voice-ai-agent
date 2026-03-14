import { AppointmentService } from '../services/appointment.service';
import { ConversationService } from '../services/conversation.service';
import { AgentSessionContext } from '../types/session';

export interface ToolResult {
    name: string;
    result: any;
    latencyMs: number;
}

export async function executeToolCall(
    name: string,
    args: Record<string, any>,
    sessionContext: AgentSessionContext,
): Promise<ToolResult> {
    const start = performance.now();
    let result: any;

    args = args ?? {};

    switch (name) {
        case 'check_availability':
            await ConversationService.setIntent(sessionContext.sessionId, 'book', 'checking_availability');
            result = await AppointmentService.checkAvailability({
                specialty: args.specialty,
                doctorId: args.doctor_id,
                date: args.date,
            });
            await ConversationService.rememberAvailability(sessionContext.sessionId, {
                specialty: args.specialty,
                doctorId: args.doctor_id,
                date: args.date,
            });
            await ConversationService.rememberDoctorResults(
                sessionContext.sessionId,
                result.map((item: any) => item.doctor).filter(Boolean),
            );
            await ConversationService.rememberToolResult(
                sessionContext.sessionId,
                `Availability checked for ${args.date}${args.specialty ? `, specialty ${args.specialty}` : ''}${args.doctor_id ? `, doctor ${args.doctor_id}` : ''}.`,
                'Awaiting patient selection of a slot.',
            );
            break;

        case 'book_appointment': {
            const patient = await AppointmentService.findOrCreatePatient({
                name: args.patient_name,
                phone: args.patient_phone,
                preferredLanguage: sessionContext.language,
            });

            sessionContext.patientId = patient.id;
            sessionContext.patientName = patient.name;
            await ConversationService.attachPatient(sessionContext.sessionId, patient);
            await ConversationService.setIntent(sessionContext.sessionId, 'book', 'booking');

            result = await AppointmentService.bookAppointment({
                patientId: patient.id,
                doctorId: args.doctor_id,
                dateTime: args.date_time,
                reason: args.reason,
            });

            if (result.success && result.appointment) {
                await ConversationService.rememberAppointmentResults(sessionContext.sessionId, [result.appointment]);
            }

            await ConversationService.rememberToolResult(
                sessionContext.sessionId,
                result.success
                    ? `Booked appointment ${result.appointment?.id || 'unknown'} for ${patient.name}.`
                    : `Booking failed: ${result.error}`,
                result.success ? undefined : 'Awaiting patient confirmation of an alternative slot.',
            );
            break;
        }

        case 'find_patient_appointments': {
            const patient = await AppointmentService.findOrCreatePatient({
                name: args.patient_name,
                phone: args.patient_phone,
                preferredLanguage: sessionContext.language,
            });

            sessionContext.patientId = patient.id;
            sessionContext.patientName = patient.name;
            await ConversationService.attachPatient(sessionContext.sessionId, patient);

            result = await AppointmentService.findPatientAppointments({
                patientId: patient.id,
                patientName: args.patient_name,
                patientPhone: args.patient_phone,
                doctorName: args.doctor_name,
                date: args.date,
                status: args.status === 'all' ? undefined : (args.status || 'confirmed'),
            });

            await ConversationService.rememberAppointmentResults(sessionContext.sessionId, result);
            await ConversationService.rememberToolResult(
                sessionContext.sessionId,
                `Found ${Array.isArray(result) ? result.length : 0} appointment candidates for ${patient.name}.`,
                'Awaiting patient confirmation of the appointment selection.',
            );
            break;
        }

        case 'reschedule_appointment': {
            const patient = await AppointmentService.findOrCreatePatient({
                name: args.patient_name,
                phone: args.patient_phone,
                preferredLanguage: sessionContext.language,
            });

            sessionContext.patientId = patient.id;
            sessionContext.patientName = patient.name;
            await ConversationService.attachPatient(sessionContext.sessionId, patient);
            await ConversationService.setIntent(sessionContext.sessionId, 'reschedule', 'rescheduling');

            result = await AppointmentService.rescheduleAppointment({
                appointmentId: args.appointment_id,
                newDateTime: args.new_date_time,
                patientId: patient.id,
            });

            if (result.success && result.appointment) {
                await ConversationService.rememberAppointmentResults(sessionContext.sessionId, [result.appointment]);
            }

            await ConversationService.rememberToolResult(
                sessionContext.sessionId,
                result.success
                    ? `Rescheduled appointment ${args.appointment_id} for ${patient.name}.`
                    : `Reschedule failed: ${result.error}`,
                result.success ? undefined : 'Awaiting patient decision on alternative times.',
            );
            break;
        }

        case 'cancel_appointment': {
            const patient = await AppointmentService.findOrCreatePatient({
                name: args.patient_name,
                phone: args.patient_phone,
                preferredLanguage: sessionContext.language,
            });

            sessionContext.patientId = patient.id;
            sessionContext.patientName = patient.name;
            await ConversationService.attachPatient(sessionContext.sessionId, patient);
            await ConversationService.setIntent(sessionContext.sessionId, 'cancel', 'cancelling');

            result = await AppointmentService.cancelAppointment({
                appointmentId: args.appointment_id,
                patientId: patient.id,
            });

            await ConversationService.rememberToolResult(
                sessionContext.sessionId,
                result.success
                    ? `Cancelled appointment ${args.appointment_id} for ${patient.name}.`
                    : `Cancellation failed: ${result.error}`,
            );
            break;
        }

        case 'list_appointments': {
            const patient = await AppointmentService.findOrCreatePatient({
                name: args.patient_name,
                phone: args.patient_phone,
                preferredLanguage: sessionContext.language,
            });

            sessionContext.patientId = patient.id;
            sessionContext.patientName = patient.name;
            await ConversationService.attachPatient(sessionContext.sessionId, patient);
            await ConversationService.setIntent(sessionContext.sessionId, 'list', 'listing_appointments');

            result = await AppointmentService.listAppointments({
                patientId: patient.id,
                status: args.status === 'all' ? undefined : (args.status || 'confirmed'),
            });

            await ConversationService.rememberAppointmentResults(sessionContext.sessionId, result);
            await ConversationService.rememberToolResult(
                sessionContext.sessionId,
                `Listed appointments for ${patient.name}.`,
            );
            break;
        }

        case 'get_doctor_info':
            result = args.doctor_id
                ? await AppointmentService.getDoctorInfo(args.doctor_id)
                : await AppointmentService.getDoctorsBySpecialty(args.specialty || '');

            if (Array.isArray(result)) {
                await ConversationService.rememberDoctorResults(
                    sessionContext.sessionId,
                    result.map((doctor: any) => ({ id: doctor.id, name: doctor.name, specialty: doctor.specialty })),
                );
            } else if (result?.id) {
                await ConversationService.rememberDoctorResults(sessionContext.sessionId, [
                    { id: result.id, name: result.name, specialty: result.specialty },
                ]);
            }

            await ConversationService.rememberToolResult(
                sessionContext.sessionId,
                args.doctor_id
                    ? `Loaded doctor info for ${args.doctor_id}.`
                    : `Loaded doctors for specialty ${args.specialty || 'all'}.`,
            );
            break;

        default:
            result = { error: `Unknown tool: ${name}` };
    }

    return {
        name,
        result,
        latencyMs: performance.now() - start,
    };
}
