import { patients } from '../db/schema';
import { db } from '../db';
import { eq } from 'drizzle-orm';
import { DataService } from './db.service';
import { AgentLanguage, AppointmentIntent, SessionMemory, SessionMode } from '../types/session';

function nowIso() {
    return new Date().toISOString();
}

const SPECIALTY_ALIASES: Array<{ pattern: RegExp; specialty: string }> = [
    { pattern: /\b(general physician|physician|general doctor|family doctor)\b/i, specialty: 'general_physician' },
    { pattern: /\b(cardiologist|cardiology|heart doctor)\b/i, specialty: 'cardiologist' },
    { pattern: /\b(neurologist|neurology)\b/i, specialty: 'neurologist' },
    { pattern: /\b(dermatologist|dermatology|skin doctor)\b/i, specialty: 'dermatologist' },
    { pattern: /\b(pediatrician|pediatrics|child doctor)\b/i, specialty: 'pediatrician' },
    { pattern: /\b(orthopedist|orthopedic|bone doctor)\b/i, specialty: 'orthopedist' },
    { pattern: /\b(gynecologist|gynaecologist|gynecology|gynaecology)\b/i, specialty: 'gynecologist' },
];

export class ConversationService {
    static inferIntentFromText(text: string): AppointmentIntent {
        const normalized = text.toLowerCase();

        if (/\b(reschedule|change|move|shift)\b/.test(normalized)) {
            return 'reschedule';
        }

        if (/\b(cancel|delete|remove)\b/.test(normalized)) {
            return 'cancel';
        }

        if (/\b(list|show|upcoming|existing|my appointments|my booking|my bookings)\b/.test(normalized)) {
            return 'list';
        }

        if (/\b(book|appointment|schedule|consultation|visit|doctor|physician|specialist|meet)\b/.test(normalized)) {
            return 'book';
        }

        return 'unknown';
    }

    static extractPhoneNumber(text: string): string | undefined {
        const digits = text.replace(/\D/g, '');
        if (digits.length >= 10 && digits.length <= 12) {
            return digits.slice(-10);
        }
        return undefined;
    }

    static extractName(text: string): string | undefined {
        const trimmed = text.trim();
        const matchers = [
            /\bmy name is\s+([a-z][a-z\s.'-]{1,60})$/i,
            /\bi am\s+([a-z][a-z\s.'-]{1,60})$/i,
            /\bthis is\s+([a-z][a-z\s.'-]{1,60})$/i,
        ];

        for (const matcher of matchers) {
            const match = trimmed.match(matcher);
            if (!match) continue;

            const name = match[1]
                .replace(/\s+/g, ' ')
                .trim()
                .replace(/[.]+$/g, '');

            if (name.length >= 2) {
                return name;
            }
        }

        if (/^[a-z][a-z\s.'-]{1,40}$/i.test(trimmed) && trimmed.split(/\s+/).length <= 4) {
            return trimmed.replace(/\s+/g, ' ').replace(/[.]+$/g, '').trim();
        }

        return undefined;
    }

    static extractSpecialty(text: string): string | undefined {
        for (const alias of SPECIALTY_ALIASES) {
            if (alias.pattern.test(text)) {
                return alias.specialty;
            }
        }
        return undefined;
    }

    static async initializeSession(params: {
        sessionId: string;
        language: AgentLanguage;
        mode?: SessionMode;
        patientId?: number;
        campaignContext?: SessionMemory['campaignContext'];
    }) {
        const existing = await DataService.getSessionMemory(params.sessionId);
        if (existing) {
            return existing;
        }

        const memory: SessionMemory = {
            sessionId: params.sessionId,
            mode: params.mode || 'inbound',
            language: params.language,
            patientId: params.patientId,
            campaignContext: params.campaignContext,
            createdAt: nowIso(),
            updatedAt: nowIso(),
        };

        if (params.patientId) {
            const [patient] = await db.select().from(patients).where(eq(patients.id, params.patientId));
            if (patient) {
                memory.patientName = patient.name;
                memory.patientPhone = patient.phone || undefined;
                memory.language = (patient.preferredLanguage as AgentLanguage) || params.language;
            }
        }

        await DataService.setSessionMemory(params.sessionId, memory);
        return memory;
    }

    static async getSessionMemory(sessionId: string) {
        return DataService.getSessionMemory(sessionId);
    }

    static async updateSessionMemory(sessionId: string, patch: Partial<SessionMemory>) {
        const existing = await DataService.getSessionMemory(sessionId);
        const merged: SessionMemory = {
            sessionId,
            mode: patch.mode || existing?.mode || 'inbound',
            language: patch.language || existing?.language || 'en',
            createdAt: existing?.createdAt || nowIso(),
            updatedAt: nowIso(),
            ...(existing || {}),
            ...patch,
        };

        await DataService.setSessionMemory(sessionId, merged);
        return merged;
    }

    static async updateIntentFromUserInput(sessionId: string, userInput: string) {
        const inferredIntent = ConversationService.inferIntentFromText(userInput);
        if (inferredIntent === 'unknown') {
            return DataService.getSessionMemory(sessionId);
        }

        return ConversationService.updateSessionMemory(sessionId, {
            currentIntent: inferredIntent,
            conversationStage: 'intake',
        });
    }

    static async captureUserDetails(sessionId: string, userInput: string) {
        const patch: Partial<SessionMemory> = {};
        const extractedName = ConversationService.extractName(userInput);
        const extractedPhone = ConversationService.extractPhoneNumber(userInput);
        const extractedSpecialty = ConversationService.extractSpecialty(userInput);

        if (extractedName) {
            patch.patientName = extractedName;
        }

        if (extractedPhone) {
            patch.patientPhone = extractedPhone;
        }

        if (extractedSpecialty) {
            patch.requestedSpecialty = extractedSpecialty;
        }

        if (Object.keys(patch).length === 0) {
            return DataService.getSessionMemory(sessionId);
        }

        return ConversationService.updateSessionMemory(sessionId, patch);
    }

    static async attachPatient(sessionId: string, patient: {
        id: number;
        name: string;
        phone?: string | null;
        preferredLanguage?: string | null;
    }) {
        return ConversationService.updateSessionMemory(sessionId, {
            patientId: patient.id,
            patientName: patient.name,
            patientPhone: patient.phone || undefined,
            language: (patient.preferredLanguage as AgentLanguage) || 'en',
        });
    }

    static async setIntent(sessionId: string, intent: AppointmentIntent, conversationStage?: string) {
        return ConversationService.updateSessionMemory(sessionId, {
            currentIntent: intent,
            conversationStage,
        });
    }

    static async rememberAvailability(sessionId: string, query: SessionMemory['lastAvailabilityQuery']) {
        return ConversationService.updateSessionMemory(sessionId, {
            lastAvailabilityQuery: query,
            requestedSpecialty: query?.specialty,
            conversationStage: 'availability_presented',
        });
    }

    static async rememberDoctorResults(sessionId: string, doctors: Array<{ id: number; name: string; specialty: string }>) {
        return ConversationService.updateSessionMemory(sessionId, {
            lastDoctorResults: doctors.slice(0, 5),
        });
    }

    static async rememberAppointmentResults(
        sessionId: string,
        appointments: Array<{ id: number; doctorName: string; doctorSpecialty: string; appointmentAt: string | Date; status: string }>,
    ) {
        return ConversationService.updateSessionMemory(sessionId, {
            lastAppointmentResults: appointments.slice(0, 5).map((appointment) => ({
                id: appointment.id,
                doctorName: appointment.doctorName,
                doctorSpecialty: appointment.doctorSpecialty,
                appointmentAt: new Date(appointment.appointmentAt).toISOString(),
                status: appointment.status,
            })),
        });
    }

    static async rememberToolResult(sessionId: string, summary: string, pendingConfirmation?: string) {
        return ConversationService.updateSessionMemory(sessionId, {
            lastToolResultSummary: summary,
            pendingConfirmation,
        });
    }

    static async buildPromptContext(sessionId: string) {
        const memory = await DataService.getSessionMemory(sessionId);
        if (!memory) {
            return 'No active session memory.';
        }

        const lines = [
            `Session mode: ${memory.mode}`,
            `Language: ${memory.language}`,
            `Current intent: ${memory.currentIntent || 'unknown'}`,
            `Conversation stage: ${memory.conversationStage || 'uninitialized'}`,
            `Known patient: ${memory.patientName ? `${memory.patientName} (ID: ${memory.patientId || 'unknown'})` : 'not identified yet'}`,
        ];

        if (memory.patientPhone) {
            lines.push(`Patient phone: ${memory.patientPhone}`);
        }

        if (memory.requestedSpecialty) {
            lines.push(`Requested specialty: ${memory.requestedSpecialty}`);
        }

        if (memory.pendingConfirmation) {
            lines.push(`Pending confirmation: ${memory.pendingConfirmation}`);
        }

        if (memory.lastAvailabilityQuery) {
            lines.push(`Last availability query: ${JSON.stringify(memory.lastAvailabilityQuery)}`);
        }

        if (memory.lastDoctorResults?.length) {
            lines.push(`Last doctor results: ${JSON.stringify(memory.lastDoctorResults)}`);
        }

        if (memory.lastAppointmentResults?.length) {
            lines.push(`Last appointment results: ${JSON.stringify(memory.lastAppointmentResults)}`);
        }

        if (memory.campaignContext) {
            lines.push(`Campaign context: ${JSON.stringify(memory.campaignContext)}`);
        }

        if (memory.lastToolResultSummary) {
            lines.push(`Last tool result summary: ${memory.lastToolResultSummary}`);
        }

        return lines.join('\n');
    }
}
