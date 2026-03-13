import { AppointmentService } from '../services/appointment.service';

export interface ToolResult {
    name: string;
    result: any;
    latencyMs: number;
}

export async function executeToolCall(
    name: string,
    args: Record<string, any>,
    sessionContext: { patientId?: number; language?: string }
): Promise<ToolResult> {
    const start = performance.now();
    let result: any;

    // Guard: args can be null if LLM sends empty arguments
    args = args ?? {};

    switch (name) {
        case 'check_availability':
            result = await AppointmentService.checkAvailability({
                specialty: args.specialty,
                doctorId: args.doctor_id,
                date: args.date,
            });
            break;

        case 'book_appointment': {
            const patient = await AppointmentService.findOrCreatePatient({
                name: args.patient_name,
                phone: args.patient_phone,
                preferredLanguage: sessionContext.language,
            });
            sessionContext.patientId = patient.id;
            result = await AppointmentService.bookAppointment({
                patientId: patient.id,
                doctorId: args.doctor_id,
                dateTime: args.date_time,
                reason: args.reason,
            });
            break;
        }

        case 'reschedule_appointment': {
            const patient = await AppointmentService.findOrCreatePatient({
                name: args.patient_name,
            });
            sessionContext.patientId = patient.id;
            result = await AppointmentService.rescheduleAppointment({
                appointmentId: args.appointment_id,
                newDateTime: args.new_date_time,
                patientId: patient.id,
            });
            break;
        }

        case 'cancel_appointment': {
            const patient = await AppointmentService.findOrCreatePatient({
                name: args.patient_name,
            });
            sessionContext.patientId = patient.id;
            result = await AppointmentService.cancelAppointment({
                appointmentId: args.appointment_id,
                patientId: patient.id,
            });
            break;
        }

        case 'list_appointments': {
            const patient = await AppointmentService.findOrCreatePatient({
                name: args.patient_name,
                phone: args.patient_phone,
            });
            sessionContext.patientId = patient.id;
            result = await AppointmentService.listAppointments({
                patientId: patient.id,
                status: args.status === 'all' ? undefined : (args.status || 'confirmed'),
            });
            break;
        }

        case 'get_doctor_info':
            if (args.doctor_id) {
                result = await AppointmentService.getDoctorInfo(args.doctor_id);
            } else {
                result = await AppointmentService.getDoctorsBySpecialty(args.specialty || '');
            }
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
