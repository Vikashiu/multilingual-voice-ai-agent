import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { config } from '../config/env';
import { DataService } from './db.service';
import { TOOL_DEFINITIONS } from '../tools/definitions';
import { executeToolCall } from '../tools/executor';
import { buildSystemPrompt } from '../tools/system-prompt';
import { AppointmentService } from './appointment.service';
import { ConversationService } from './conversation.service';
import { AgentSessionContext } from '../types/session';

const MAX_TOOL_ROUNDS = 5;
const MAX_HISTORY_MESSAGES = 8;

interface ToolCallAccumulator {
    id: string;
    name: string;
    arguments: string;
}

export interface ToolAction {
    tool: string;
    args: Record<string, any>;
    result: any;
    latencyMs: number;
}

interface PlannerRoundResult {
    content: string;
    toolCalls: ToolCallAccumulator[];
}

interface SanitizedToolCall {
    args: Record<string, any>;
    validationError?: string;
}

const INVALID_PATIENT_NAMES = new Set([
    'my',
    'me',
    'i',
    'unknown',
    'your_phone_number',
    'patient',
]);

export class LLMService {
    private client: OpenAI;
    private sessionContext: AgentSessionContext;
    private model: string;

    constructor(sessionContext: AgentSessionContext) {
        this.sessionContext = sessionContext;
        this.model = config.GROQ_MODEL;
        this.client = new OpenAI({
            apiKey: config.GROQ_API_KEY,
            baseURL: 'https://api.groq.com/openai/v1',
        });
    }

    private async buildMessages(sessionId: string, userInput: string): Promise<ChatCompletionMessageParam[]> {
        const history = (await DataService.getChatHistory(sessionId)).slice(-MAX_HISTORY_MESSAGES);
        const sessionMemory = await ConversationService.getSessionMemory(sessionId);

        if (sessionMemory?.patientId) {
            this.sessionContext.patientId = sessionMemory.patientId;
            this.sessionContext.patientName = sessionMemory.patientName;
            this.sessionContext.language = sessionMemory.language;
        }

        let patientContext = await ConversationService.buildPromptContext(sessionId);

        if (this.sessionContext.patientId) {
            const crossSessionContext = await AppointmentService.getPatientContext(this.sessionContext.patientId);
            if (crossSessionContext) {
                const appointments = crossSessionContext.recentAppointments
                    .map(
                        (appointment) =>
                            `- ${new Date(appointment.appointmentAt).toLocaleString()}: ${appointment.doctorName} (${appointment.doctorSpecialty}) - ${appointment.status}`,
                    )
                    .join('\n');

                patientContext = `${patientContext}

Returning patient profile:
Name: ${crossSessionContext.patient.name}
Patient ID: ${crossSessionContext.patient.id}
Phone: ${crossSessionContext.patient.phone || 'unknown'}
Preferred language: ${crossSessionContext.patient.preferredLanguage}
Recent appointments:
${appointments || 'None'}
Notes: ${crossSessionContext.patient.notes || 'None'}`;
            }
        }

        const systemPrompt = buildSystemPrompt(this.sessionContext.language, patientContext);
        return [
            { role: 'system', content: systemPrompt },
            ...history.map((entry: any) => ({
                role: entry.role === 'model' ? 'assistant' : entry.role,
                content: entry.text,
            })),
            { role: 'user', content: userInput },
        ];
    }

    private async runPlannerRound(messages: ChatCompletionMessageParam[]): Promise<PlannerRoundResult> {
        try {
            const completion = await this.client.chat.completions.create({
                model: this.model,
                messages,
                tools: TOOL_DEFINITIONS,
                tool_choice: 'auto',
                stream: false,
                max_completion_tokens: 220,
            });

            const message = completion.choices[0]?.message;
            const content = this.stripFunctionMarkup(message?.content || '');
            const toolCalls: ToolCallAccumulator[] = (message?.tool_calls || [])
                .filter((toolCall) => toolCall.type === 'function')
                .map((toolCall) => ({
                    id: toolCall.id,
                    name: toolCall.function.name,
                    arguments: toolCall.function.arguments,
                }));

            if (toolCalls.length === 0) {
                const recovered = this.extractToolCallsFromContent(message?.content || '');
                if (recovered.toolCalls.length > 0) {
                    return recovered;
                }
            }

            return { content, toolCalls };
        } catch (error: any) {
            if (error?.code !== 'tool_use_failed') {
                throw error;
            }

            const recovered = this.recoverPlannerRoundFromToolFailure(error);
            if (recovered) {
                return recovered;
            }

            throw error;
        }
    }

    private recoverPlannerRoundFromToolFailure(error: any): PlannerRoundResult | null {
        const failedGeneration = error?.error?.failed_generation as string | undefined;
        if (!failedGeneration) {
            return null;
        }

        const toolTagPatterns = [
            /<function=([a-z_]+)\s+(\{[\s\S]*?\})><\/function>/i,
            /<function=([a-z_]+)>(\{[\s\S]*?\})<\/function>/i,
        ];

        for (const pattern of toolTagPatterns) {
            const match = failedGeneration.match(pattern);
            if (!match) continue;

            const toolName = match[1];
            const toolArgs = match[2];
            const content = failedGeneration.replace(match[0], '').trim();

            console.warn(`[LLM] Recovered malformed tool call for ${toolName}.`);

            return {
                content,
                toolCalls: [
                    {
                        id: `recovered_${Date.now()}`,
                        name: toolName,
                        arguments: toolArgs,
                    },
                ],
            };
        }

        return {
            content: this.stripFunctionMarkup(failedGeneration),
            toolCalls: [],
        };
    }

    private stripFunctionMarkup(text: string) {
        return text
            .replace(/<function[\s\S]*?<\/function>/gi, '')
            .replace(/<\/?function[^>]*>/gi, '')
            .replace(/<\/?tool[^>]*>/gi, '')
            .trim();
    }

    private extractToolCallsFromContent(text: string): PlannerRoundResult {
        const toolCalls: ToolCallAccumulator[] = [];
        const patterns = [
            /<function=([a-z_]+)\s+(\{[\s\S]*?\})><\/function>/gi,
            /<function=([a-z_]+)>(\{[\s\S]*?\})<\/function>/gi,
        ];

        for (const pattern of patterns) {
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(text)) !== null) {
                toolCalls.push({
                    id: `recovered_${Date.now()}_${toolCalls.length}`,
                    name: match[1],
                    arguments: match[2],
                });
            }
        }

        return {
            content: this.stripFunctionMarkup(text),
            toolCalls,
        };
    }

    private isGreetingOrUnclearTurn(userInput: string) {
        const normalized = userInput.trim().toLowerCase();
        if (!normalized) return true;

        if (/^(hi|hello|hey|hello\?|hi\?|hey\?|good morning|good evening)$/.test(normalized)) {
            return true;
        }

        if (normalized.split(/\s+/).length <= 2 && /^(my|okay|ok|so|hello\??|hey\??)$/.test(normalized)) {
            return true;
        }

        return false;
    }

    private parseNumericField(value: unknown): number | undefined {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }

        if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
            return Number(value.trim());
        }

        return undefined;
    }

    private async enrichToolArgsFromMemory(name: string, args: Record<string, any>) {
        const memory = await ConversationService.getSessionMemory(this.sessionContext.sessionId);
        if (!memory) {
            return args;
        }

        const enriched = { ...args };

        if (!enriched.patient_name && memory.patientName) {
            enriched.patient_name = memory.patientName;
        }

        if (!enriched.patient_phone && memory.patientPhone) {
            enriched.patient_phone = memory.patientPhone;
        }

        if (!enriched.specialty && memory.requestedSpecialty && ['get_doctor_info', 'check_availability'].includes(name)) {
            enriched.specialty = memory.requestedSpecialty;
        }

        if (enriched.doctor_id === undefined && memory.lastDoctorResults?.length === 1) {
            enriched.doctor_id = memory.lastDoctorResults[0].id;
        }

        if (enriched.appointment_id === undefined && memory.lastAppointmentResults?.length === 1) {
            enriched.appointment_id = memory.lastAppointmentResults[0].id;
        }

        return enriched;
    }

    private sanitizeToolArgs(name: string, args: Record<string, any>): SanitizedToolCall {
        const sanitized = { ...args };

        if (['book_appointment', 'list_appointments', 'find_patient_appointments', 'cancel_appointment', 'reschedule_appointment'].includes(name)) {
            const normalizedName = typeof sanitized.patient_name === 'string'
                ? sanitized.patient_name.trim().toLowerCase()
                : '';

            if (!sanitized.patient_name || INVALID_PATIENT_NAMES.has(normalizedName)) {
                return {
                    args: sanitized,
                    validationError: 'I need the patient name before I can access appointment records.',
                };
            }
        }

        if (typeof sanitized.patient_phone === 'string') {
            const normalizedPhone = sanitized.patient_phone.trim().toLowerCase();
            if (!normalizedPhone || ['unknown', 'your_phone_number', 'none', 'null'].includes(normalizedPhone)) {
                delete sanitized.patient_phone;
            }
        }

        if (name === 'check_availability' && sanitized.doctor_id !== undefined) {
            const doctorId = this.parseNumericField(sanitized.doctor_id);
            if (doctorId === undefined) {
                return {
                    args: sanitized,
                    validationError: 'I need a valid doctor selection before I can check that doctor\'s availability.',
                };
            }
            sanitized.doctor_id = doctorId;
        }

        if (name === 'book_appointment') {
            const doctorId = this.parseNumericField(sanitized.doctor_id);
            if (doctorId === undefined) {
                return {
                    args: sanitized,
                    validationError: 'I could not identify a valid doctor ID for booking. Please choose one of the doctors from the shown options first.',
                };
            }
            sanitized.doctor_id = doctorId;
        }

        if (name === 'reschedule_appointment') {
            const appointmentId = this.parseNumericField(sanitized.appointment_id);
            if (appointmentId === undefined) {
                return {
                    args: sanitized,
                    validationError: 'I need a valid appointment ID before I can reschedule this booking.',
                };
            }
            sanitized.appointment_id = appointmentId;
        }

        if (name === 'cancel_appointment') {
            const appointmentId = this.parseNumericField(sanitized.appointment_id);
            if (appointmentId === undefined) {
                return {
                    args: sanitized,
                    validationError: 'I need a valid appointment ID before I can cancel this booking.',
                };
            }
            sanitized.appointment_id = appointmentId;
        }

        if (name === 'find_patient_appointments' && sanitized.appointment_id !== undefined) {
            delete sanitized.appointment_id;
        }

        return { args: sanitized };
    }

    private async streamFinalResponse(
        messages: ChatCompletionMessageParam[],
        onChunk: (text: string) => void | Promise<void>,
        isInterrupted?: () => boolean,
    ) {
        const responseMessages: ChatCompletionMessageParam[] = [
            ...messages,
            {
                role: 'system',
                content:
                    'Respond to the patient naturally in a short voice-friendly way. Do not call any tools now. Use the tool results already in the conversation and clearly state the outcome or next question.',
            },
        ];

        const stream = await this.client.chat.completions.create({
            model: this.model,
            messages: responseMessages,
            stream: true,
            max_completion_tokens: 180,
        });

        let fullResponse = '';

        for await (const chunk of stream) {
            if (isInterrupted?.()) break;

            const text = chunk.choices[0]?.delta?.content;
            if (!text) continue;

            fullResponse += text;
        }

        const cleaned = this.stripFunctionMarkup(fullResponse);
        if (cleaned) {
            await onChunk(cleaned);
        }

        return cleaned;
    }

    public async generateResponse(
        sessionId: string,
        userInput: string,
        onChunk: (text: string) => void | Promise<void>,
        onToolAction?: (action: ToolAction) => void,
        isInterrupted?: () => boolean,
    ) {
        try {
            await ConversationService.updateIntentFromUserInput(sessionId, userInput);
            await ConversationService.captureUserDetails(sessionId, userInput);
            await DataService.saveToCache(sessionId, 'user', userInput);

            const messages = await this.buildMessages(sessionId, userInput);

            if (this.isGreetingOrUnclearTurn(userInput)) {
                const directResponse = await this.streamFinalResponse(messages, onChunk, isInterrupted);
                if (directResponse.trim()) {
                    await DataService.saveToCache(sessionId, 'model', directResponse);
                }
                return;
            }

            for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
                if (isInterrupted?.()) break;

                const plannerResult = await this.runPlannerRound(messages);

                messages.push({
                    role: 'assistant',
                    content: plannerResult.content || null,
                    ...(plannerResult.toolCalls.length > 0
                        ? {
                            tool_calls: plannerResult.toolCalls.map((toolCall) => ({
                                id: toolCall.id,
                                type: 'function' as const,
                                function: {
                                    name: toolCall.name,
                                    arguments: toolCall.arguments,
                                },
                            })),
                        }
                        : {}),
                });

                if (plannerResult.toolCalls.length === 0) {
                    const fallbackText = plannerResult.content?.trim();
                    let finalResponse = '';

                    if (fallbackText) {
                        finalResponse = fallbackText;
                        await onChunk(fallbackText);
                    } else {
                        finalResponse = await this.streamFinalResponse(messages, onChunk, isInterrupted);
                    }

                    if (finalResponse.trim()) {
                        await DataService.saveToCache(sessionId, 'model', finalResponse);
                    }

                    return;
                }

                for (const toolCall of plannerResult.toolCalls) {
                    if (isInterrupted?.()) break;

                    let parsedArgs: Record<string, any> = {};

                    try {
                        const parsed = JSON.parse(toolCall.arguments);
                        parsedArgs = parsed && typeof parsed === 'object' ? parsed : {};
                    } catch {
                        console.error(`Failed to parse tool args for ${toolCall.name}:`, toolCall.arguments);
                    }

                    const enrichedArgs = await this.enrichToolArgsFromMemory(toolCall.name, parsedArgs);
                    const sanitized = this.sanitizeToolArgs(toolCall.name, enrichedArgs);
                    const toolResult = sanitized.validationError
                        ? {
                            name: toolCall.name,
                            result: {
                                success: false,
                                error: sanitized.validationError,
                                rawArgs: parsedArgs,
                            },
                            latencyMs: 0,
                        }
                        : await executeToolCall(toolCall.name, sanitized.args, this.sessionContext);

                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify(toolResult.result),
                    });

                    if (this.sessionContext.patientId) {
                        await DataService.setSessionMeta(sessionId, {
                            patient_id: String(this.sessionContext.patientId),
                            language: this.sessionContext.language,
                        });
                    }

                    onToolAction?.({
                        tool: toolResult.name,
                        args: parsedArgs,
                        result: toolResult.result,
                        latencyMs: toolResult.latencyMs,
                    });
                }
            }

            const finalResponse = await this.streamFinalResponse(messages, onChunk, isInterrupted);
            if (finalResponse.trim()) {
                await DataService.saveToCache(sessionId, 'model', finalResponse);
            }
        } catch (error: any) {
            console.error('LLM Error:', error);

            if (error?.status === 429 || error?.code === 'rate_limit_exceeded') {
                const retryAfter = error?.headers?.get?.('retry-after');
                const retryMinutes = retryAfter ? Math.max(1, Math.ceil(Number(retryAfter) / 60)) : null;
                const message = retryMinutes
                    ? `The AI service has reached its token limit right now. Please try again in about ${retryMinutes} minutes.`
                    : 'The AI service has reached its token limit right now. Please try again shortly.';
                await onChunk(message);
                return;
            }

            await onChunk("I'm sorry, I ran into a temporary issue. Please try again.");
        }
    }
}
