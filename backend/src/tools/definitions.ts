import { ChatCompletionTool } from 'openai/resources/chat/completions';

export const TOOL_DEFINITIONS: ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'check_availability',
            description: 'Check available appointment slots for a doctor or specialty on a given date. ALWAYS call this before booking to show the patient available times.',
            parameters: {
                type: 'object',
                properties: {
                    date: {
                        type: 'string',
                        description: 'Date to check in YYYY-MM-DD format',
                    },
                    specialty: {
                        type: 'string',
                        description: 'Medical specialty e.g. "cardiologist", "dermatologist", "general_physician", "pediatrician", "orthopedist", "gynecologist"',
                    },
                    doctor_id: {
                        type: 'number',
                        description: 'Specific doctor ID if the patient has a preference',
                    },
                },
                required: ['date'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'book_appointment',
            description: 'Book a confirmed appointment for a patient. Only call this AFTER the patient explicitly confirms the time slot.',
            parameters: {
                type: 'object',
                properties: {
                    patient_name: { type: 'string', description: 'Full name of the patient' },
                    patient_phone: { type: 'string', description: 'Phone number for patient lookup or registration' },
                    doctor_id: { type: 'number', description: 'ID of the doctor to book with' },
                    date_time: { type: 'string', description: 'Appointment datetime in ISO format YYYY-MM-DDTHH:mm:ss' },
                    reason: { type: 'string', description: 'Reason for the visit' },
                },
                required: ['patient_name', 'doctor_id', 'date_time'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'reschedule_appointment',
            description: 'Reschedule an existing appointment to a new date/time. The old appointment is marked as rescheduled.',
            parameters: {
                type: 'object',
                properties: {
                    appointment_id: { type: 'number', description: 'ID of the existing appointment to reschedule' },
                    new_date_time: { type: 'string', description: 'New datetime in ISO format YYYY-MM-DDTHH:mm:ss' },
                    patient_name: { type: 'string', description: 'Patient name for verification' },
                },
                required: ['appointment_id', 'new_date_time', 'patient_name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cancel_appointment',
            description: 'Cancel an existing appointment. Ask for confirmation before calling this.',
            parameters: {
                type: 'object',
                properties: {
                    appointment_id: { type: 'number', description: 'ID of the appointment to cancel' },
                    patient_name: { type: 'string', description: 'Patient name for verification' },
                },
                required: ['appointment_id', 'patient_name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_appointments',
            description: 'List upcoming appointments for a patient. Use when the patient asks about their existing bookings.',
            parameters: {
                type: 'object',
                properties: {
                    patient_name: { type: 'string', description: 'Patient name to look up' },
                    patient_phone: { type: 'string', description: 'Phone number for more precise lookup' },
                    status: { type: 'string', enum: ['confirmed', 'cancelled', 'all'], description: 'Filter by appointment status' },
                },
                required: ['patient_name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_doctor_info',
            description: 'Get information about available doctors, optionally filtered by specialty. Use when the patient asks about doctors or does not know whom to see.',
            parameters: {
                type: 'object',
                properties: {
                    specialty: { type: 'string', description: 'Filter by medical specialty' },
                    doctor_id: { type: 'number', description: 'Get info for a specific doctor' },
                },
                required: [],
            },
        },
    },
];
