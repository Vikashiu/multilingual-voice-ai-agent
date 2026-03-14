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
                        description: 'Medical specialty e.g. cardiologist, dermatologist, general_physician, pediatrician, orthopedist, gynecologist',
                    },
                    doctor_id: {
                        type: 'number',
                        description: 'Specific numeric doctor ID if the patient has a preference',
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
                    doctor_id: { type: 'number', description: 'Numeric ID of the doctor to book with' },
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
            name: 'find_patient_appointments',
            description: 'Find existing appointments for a patient before cancellation or rescheduling. Use this when the appointment ID is not already known.',
            parameters: {
                type: 'object',
                properties: {
                    patient_name: { type: 'string', description: 'Patient name for lookup' },
                    patient_phone: { type: 'string', description: 'Phone number for precise patient lookup' },
                    doctor_name: { type: 'string', description: 'Optional doctor name filter' },
                    date: { type: 'string', description: 'Optional date filter in YYYY-MM-DD format' },
                    status: { type: 'string', enum: ['confirmed', 'cancelled', 'rescheduled', 'all'], description: 'Appointment status filter' },
                },
                required: ['patient_name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'reschedule_appointment',
            description: 'Reschedule an existing appointment to a new date/time. Use a real appointment ID from appointment lookup results.',
            parameters: {
                type: 'object',
                properties: {
                    appointment_id: { type: 'number', description: 'Numeric ID of the existing appointment to reschedule' },
                    new_date_time: { type: 'string', description: 'New datetime in ISO format YYYY-MM-DDTHH:mm:ss' },
                    patient_name: { type: 'string', description: 'Patient name for verification' },
                    patient_phone: { type: 'string', description: 'Phone number for more precise patient lookup' },
                },
                required: ['appointment_id', 'new_date_time', 'patient_name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cancel_appointment',
            description: 'Cancel an existing appointment. Ask for confirmation before calling this and use a real appointment ID from tool results.',
            parameters: {
                type: 'object',
                properties: {
                    appointment_id: { type: 'number', description: 'Numeric ID of the appointment to cancel' },
                    patient_name: { type: 'string', description: 'Patient name for verification' },
                    patient_phone: { type: 'string', description: 'Phone number for more precise patient lookup' },
                },
                required: ['appointment_id', 'patient_name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_appointments',
            description: 'List appointments for a patient. Use when the patient asks about their existing bookings or when you need IDs for a follow-up action.',
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
                    doctor_id: { type: 'number', description: 'Get info for a specific numeric doctor ID' },
                },
                required: [],
            },
        },
    },
];
