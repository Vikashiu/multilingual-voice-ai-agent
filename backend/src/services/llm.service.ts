import OpenAI from 'openai';
import { config } from '../config/env';
import { DataService } from './db.service';
import { TOOL_DEFINITIONS } from '../tools/definitions';
import { executeToolCall } from '../tools/executor';
import { buildSystemPrompt } from '../tools/system-prompt';
import { AppointmentService } from './appointment.service';

const MAX_TOOL_ROUNDS = 5;

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

export class LLMService {
    private client: OpenAI;
    private langCode: string;
    private sessionContext: { patientId?: number; language?: string };

    constructor(langCode: string = 'en') {
        this.langCode = langCode;
        this.sessionContext = { language: langCode };
        this.client = new OpenAI({
            apiKey: config.GROQ_API_KEY,
            baseURL: "https://api.groq.com/openai/v1"
        });
    }

    public async generateResponse(
        sessionId: string,
        userInput: string,
        onChunk: (text: string) => void | Promise<void>,
        onToolAction?: (action: ToolAction) => void,
        isInterrupted?: () => boolean,
    ) {
        try {
            // 1. Load chat history from Redis
            const history = await DataService.getChatHistory(sessionId);

            // 2. Load patient context if we have a patientId
            let patientContext: string | undefined;
            const sessionMeta = await DataService.getSessionMeta(sessionId);
            if (sessionMeta?.patient_id) {
                this.sessionContext.patientId = parseInt(sessionMeta.patient_id);
                const ctx = await AppointmentService.getPatientContext(this.sessionContext.patientId);
                if (ctx) {
                    const appts = ctx.recentAppointments.map(a =>
                        `- ${new Date(a.appointmentAt).toLocaleDateString()}: ${a.doctorName} (${a.doctorSpecialty}) - ${a.status}`
                    ).join('\n');
                    patientContext = `Returning patient: ${ctx.patient.name} (ID: ${ctx.patient.id})\nPhone: ${ctx.patient.phone || 'unknown'}\nPreferred language: ${ctx.patient.preferredLanguage}\nRecent appointments:\n${appts || 'None'}\nNotes: ${ctx.patient.notes || 'None'}`;
                }
            }

            // 3. Build messages array
            const systemPrompt = buildSystemPrompt(this.langCode, patientContext);
            const messages: any[] = [
                { role: "system", content: systemPrompt },
                ...history.map((h: any) => ({
                    role: h.role === 'model' ? 'assistant' : h.role,
                    content: h.text
                })),
                { role: "user", content: userInput },
            ];

            // Save user message to Redis
            await DataService.saveToCache(sessionId, 'user', userInput);

            let fullAiResponse = "";

            // 4. Multi-round tool calling loop
            for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
                if (isInterrupted?.()) break;

                const stream = await this.client.chat.completions.create({
                    model: "llama-3.3-70b-versatile",
                    messages,
                    tools: TOOL_DEFINITIONS,
                    tool_choice: "auto",
                    stream: true,
                });

                let roundContent = "";
                const toolCalls: ToolCallAccumulator[] = [];
                let hasToolCalls = false;

                for await (const chunk of stream) {
                    if (isInterrupted?.()) break;

                    const delta = chunk.choices[0]?.delta;

                    // Stream content tokens to TTS immediately
                    if (delta?.content) {
                        roundContent += delta.content;
                        await onChunk(delta.content);
                    }

                    // Accumulate tool call chunks
                    if (delta?.tool_calls) {
                        hasToolCalls = true;
                        for (const tc of delta.tool_calls) {
                            if (tc.index !== undefined) {
                                while (toolCalls.length <= tc.index) {
                                    toolCalls.push({ id: '', name: '', arguments: '' });
                                }
                                if (tc.id) toolCalls[tc.index].id = tc.id;
                                if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
                                if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
                            }
                        }
                    }
                }

                fullAiResponse += roundContent;

                // If no tool calls, we're done
                if (!hasToolCalls) break;

                // 5. Push assistant message with tool_calls to messages
                messages.push({
                    role: 'assistant',
                    content: roundContent || null,
                    tool_calls: toolCalls.map(tc => ({
                        id: tc.id,
                        type: 'function' as const,
                        function: { name: tc.name, arguments: tc.arguments },
                    })),
                });

                // 6. Execute all tool calls
                for (const tc of toolCalls) {
                    if (isInterrupted?.()) break;

                    let parsedArgs: Record<string, any> = {};
                    try {
                        const parsed = JSON.parse(tc.arguments);
                        parsedArgs = (parsed && typeof parsed === 'object') ? parsed : {};
                    } catch {
                        console.error(`Failed to parse tool args for ${tc.name}:`, tc.arguments);
                    }

                    const toolResult = await executeToolCall(tc.name, parsedArgs, this.sessionContext);

                    // Push tool result message
                    messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: JSON.stringify(toolResult.result),
                    });

                    // Update session patient if resolved
                    if (this.sessionContext.patientId) {
                        await DataService.setSessionMeta(sessionId, {
                            patient_id: String(this.sessionContext.patientId),
                        });
                    }

                    // Emit reasoning trace to frontend
                    if (onToolAction) {
                        onToolAction({
                            tool: toolResult.name,
                            args: parsedArgs,
                            result: toolResult.result,
                            latencyMs: toolResult.latencyMs,
                        });
                    }

                    console.log(`[TOOL] ${tc.name} executed in ${toolResult.latencyMs.toFixed(0)}ms`);
                }

                // Loop continues — next iteration re-calls LLM with tool results
            }

            // 7. Persist assistant response to Redis
            if (fullAiResponse.trim()) {
                await DataService.saveToCache(sessionId, 'model', fullAiResponse);
            }

        } catch (error: any) {
            // Groq-specific: model generated malformed tool call syntax
            if (error?.code === 'tool_use_failed') {
                console.error("[LLM] tool_use_failed — model generated bad function call format. Sending recovery message.");
                await onChunk("I'm sorry, I had a little trouble with that. Could you please repeat your request?");
            } else {
                console.error("LLM Error:", error);
            }
        }
    }
}
