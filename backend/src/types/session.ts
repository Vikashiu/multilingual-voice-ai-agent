export type AgentLanguage = 'en' | 'hi' | 'ta';

export type SessionMode = 'inbound' | 'outbound';

export type AppointmentIntent =
    | 'book'
    | 'reschedule'
    | 'cancel'
    | 'list'
    | 'campaign_followup'
    | 'unknown';

export interface SessionMemory {
    sessionId: string;
    mode: SessionMode;
    language: AgentLanguage;
    patientId?: number;
    patientName?: string;
    patientPhone?: string;
    requestedSpecialty?: string;
    currentIntent?: AppointmentIntent;
    conversationStage?: string;
    pendingConfirmation?: string;
    lastAvailabilityQuery?: {
        doctorId?: number;
        specialty?: string;
        date: string;
    };
    lastToolResultSummary?: string;
    lastDoctorResults?: Array<{
        id: number;
        name: string;
        specialty: string;
    }>;
    lastAppointmentResults?: Array<{
        id: number;
        doctorName: string;
        doctorSpecialty: string;
        appointmentAt: string;
        status: string;
    }>;
    campaignContext?: {
        campaignId: number;
        campaignType: string;
        appointmentId?: number;
    };
    createdAt: string;
    updatedAt: string;
}

export interface AgentSessionContext {
    sessionId: string;
    patientId?: number;
    patientName?: string;
    language: AgentLanguage;
    mode: SessionMode;
}
