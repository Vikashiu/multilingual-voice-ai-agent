import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import crypto from 'crypto';
import { config } from './config/env';
import { TranscriptionService } from './services/deepgram.service';
import { TTSService } from './services/tts.service';
import { DataService } from './services/db.service';
import { LatencyTracer } from './services/latency.service';
import { CampaignService } from './services/campaign.service';
import { ConversationService } from './services/conversation.service';
import { LLMService } from './services/llm.service';
import { AppointmentService } from './services/appointment.service';
import { AgentLanguage, SessionMode } from './types/session';

const fastify = Fastify({ logger: true });
fastify.register(fastifyWebsocket);
fastify.register(fastifyCors, { origin: true });

fastify.get('/health', async () => {
    return { status: 'OK', message: 'Voice Agent API is running' };
});

fastify.post('/api/campaigns', async (req) => {
    const body = req.body as {
        name: string;
        type: string;
        targets: { patientId: number; appointmentId?: number }[];
    };

    const campaign = await CampaignService.createCampaign(body.name, body.type, body.targets);
    return { success: true, campaign };
});

fastify.post('/api/campaigns/:id/start', async (req) => {
    const { id } = req.params as { id: string };
    CampaignService.startCampaign(parseInt(id, 10)).catch((err: unknown) => {
        console.error('Campaign error:', err);
    });
    return { success: true, message: 'Campaign started' };
});

fastify.get('/api/campaigns/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    return CampaignService.getCampaignStatus(parseInt(id, 10));
});

fastify.post('/api/sessions/outbound', async (req) => {
    const body = req.body as {
        patientId: number;
        campaignId: number;
        campaignType: string;
        appointmentId?: number;
    };

    const patientContext = await AppointmentService.getPatientContext(body.patientId);
    const language = (patientContext?.patient.preferredLanguage as AgentLanguage) || 'en';
    const sessionId = crypto.randomUUID();

    await ConversationService.initializeSession({
        sessionId,
        language,
        mode: 'outbound',
        patientId: body.patientId,
        campaignContext: {
            campaignId: body.campaignId,
            campaignType: body.campaignType,
            appointmentId: body.appointmentId,
        },
    });

    return {
        success: true,
        sessionId,
        language,
        wsUrl: `/ws?sessionId=${sessionId}&mode=outbound`,
    };
});

fastify.register(async function registerVoiceRoutes(app) {
    app.get('/ws', { websocket: true }, (socket, req) => {
        const query = req.query as {
            lang?: AgentLanguage;
            sessionId?: string;
            mode?: SessionMode;
            patientId?: string;
            campaignId?: string;
            campaignType?: string;
            appointmentId?: string;
        };

        const sessionId = query.sessionId || crypto.randomUUID();
        const requestedMode = query.mode || 'inbound';
        const requestedLanguage = query.lang || 'en';

        let utteranceBuffer = '';
        let isAiSpeaking = false;
        let interruptFlag = false;
        let ttsStartTime = 0;
        let utteranceTimer: NodeJS.Timeout | null = null;

        const FINAL_TRANSCRIPT_DEBOUNCE_MS = 140;

        void (async () => {
            const initialMemory = await ConversationService.initializeSession({
                sessionId,
                language: requestedLanguage,
                mode: requestedMode,
                patientId: query.patientId ? parseInt(query.patientId, 10) : undefined,
                campaignContext: query.campaignId && query.campaignType
                    ? {
                        campaignId: parseInt(query.campaignId, 10),
                        campaignType: query.campaignType,
                        appointmentId: query.appointmentId ? parseInt(query.appointmentId, 10) : undefined,
                    }
                    : undefined,
            });

            await DataService.setSessionMeta(sessionId, {
                language: initialMemory.language,
                mode: initialMemory.mode,
                ...(initialMemory.patientId ? { patient_id: String(initialMemory.patientId) } : {}),
            });

            const transcriptionService = new TranscriptionService(initialMemory.language);
            const ttsService = new TTSService(initialMemory.language);
            const llmService = new LLMService({
                sessionId,
                language: initialMemory.language,
                mode: initialMemory.mode,
                patientId: initialMemory.patientId,
                patientName: initialMemory.patientName,
            });

            const triggerUtterance = () => {
                if (!utteranceBuffer.trim() || isAiSpeaking) {
                    return;
                }

                const fullSentence = utteranceBuffer.trim();
                utteranceBuffer = '';

                if (utteranceTimer) {
                    clearTimeout(utteranceTimer);
                    utteranceTimer = null;
                }

                isAiSpeaking = true;
                interruptFlag = false;
                ttsStartTime = Date.now();

                const tracer = new LatencyTracer(sessionId);
                tracer.sttEnd();

                void (async () => {
                    try {
                        let ttsBuffer = '';
                        let isFirstChunk = true;
                        let isFirstTTSByte = true;
                        let ttsPromise = Promise.resolve();

                        await llmService.generateResponse(
                            sessionId,
                            fullSentence,
                            async (llmChunk) => {
                                if (interruptFlag) return;

                                if (isFirstChunk) {
                                    tracer.llmFirstToken();
                                    isFirstChunk = false;
                                }

                                socket.send(JSON.stringify({ type: 'llm_chunk', sessionId, text: llmChunk }));
                                ttsBuffer += llmChunk;

                                if (/[.!?\n?]/.test(llmChunk)) {
                                    const phraseToSpeak = ttsBuffer.trim();
                                    ttsBuffer = '';

                                    if (!/\S/.test(phraseToSpeak)) {
                                        return;
                                    }

                                    ttsPromise = ttsPromise.then(async () => {
                                        if (interruptFlag) return;

                                        await ttsService.streamSpeech(phraseToSpeak, (audioBuffer) => {
                                            if (interruptFlag) return;
                                            if (isFirstTTSByte) {
                                                ttsStartTime = Date.now();
                                                tracer.ttsFirstByte();
                                                isFirstTTSByte = false;
                                            }
                                            socket.send(audioBuffer);
                                        });
                                    });
                                }
                            },
                            (toolAction) => {
                                socket.send(
                                    JSON.stringify({
                                        type: 'tool_action',
                                        sessionId,
                                        tool: toolAction.tool,
                                        args: toolAction.args,
                                        result: toolAction.result,
                                        latencyMs: toolAction.latencyMs,
                                    }),
                                );
                            },
                            () => interruptFlag,
                        );

                        if (/\S/.test(ttsBuffer.trim()) && !interruptFlag) {
                            const finalPhrase = ttsBuffer.trim();
                            ttsPromise = ttsPromise.then(async () => {
                                if (interruptFlag) return;
                                await ttsService.streamSpeech(finalPhrase, (audioBuffer) => {
                                    if (!interruptFlag) {
                                        socket.send(audioBuffer);
                                    }
                                });
                            });
                        }

                        await ttsPromise;

                        const latencyReport = tracer.report();
                        if (latencyReport) {
                            socket.send(
                                JSON.stringify({
                                    type: 'latency',
                                    sessionId,
                                    ...latencyReport,
                                }),
                            );
                        }
                    } catch (error) {
                        console.error('LLM error:', error);
                    } finally {
                        isAiSpeaking = false;
                    }
                })();
            };

            transcriptionService.startStream((text, isFinal, speechFinal) => {
                socket.send(
                    JSON.stringify({
                        type: 'transcript',
                        sessionId,
                        text,
                        isFinal,
                        speechFinal,
                    }),
                );

                if (isFinal && text.trim().length > 0) {
                    utteranceBuffer += ` ${text.trim()}`;

                    if (utteranceTimer) {
                        clearTimeout(utteranceTimer);
                    }

                    utteranceTimer = setTimeout(() => {
                        triggerUtterance();
                    }, FINAL_TRANSCRIPT_DEBOUNCE_MS);
                }

                if (speechFinal) {
                    triggerUtterance();
                }
            });

            socket.on('message', (message: Buffer) => {
                if (isAiSpeaking) {
                    return;
                }
                transcriptionService.sendAudio(message);
            });

            socket.on('close', async () => {
                if (utteranceTimer) {
                    clearTimeout(utteranceTimer);
                    utteranceTimer = null;
                }

                transcriptionService.closeStream();
                ttsService.close();

                try {
                    await DataService.archiveSession(sessionId);
                } catch (error) {
                    console.error('Failed to archive session:', error);
                }
            });

            socket.send(
                JSON.stringify({
                    type: 'session_ready',
                    sessionId,
                    language: initialMemory.language,
                    mode: initialMemory.mode,
                }),
            );
        })();
    });
});

const start = async () => {
    try {
        await fastify.listen({ port: config.PORT });
        console.log(`Server listening on port ${config.PORT}`);
    } catch (err) {
        process.exit(1);
    }
};

start();
