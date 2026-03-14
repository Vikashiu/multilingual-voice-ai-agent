# Real-Time Multilingual Clinical Voice Agent

This repository contains a low-latency voice AI backend for clinical appointment booking, rescheduling, cancellation, and outbound follow-up workflows across English, Hindi, and Tamil.

## What is implemented

- Real-time voice session loop over WebSocket
- Streaming STT -> LLM -> TTS pipeline
- Tool-based appointment orchestration with visible tool traces
- Redis-backed short-term memory with TTL
- Postgres-backed long-term patient and transcript history
- Inbound and outbound session modes
- Conflict-aware appointment booking and rescheduling
- Language continuity across returning patients
- Latency tracing from speech end to first audio byte
- Barge-in interruption handling

## Stack

- Backend: TypeScript, Fastify, WebSocket
- LLM orchestration: OpenAI-compatible SDK against Groq
- STT: Deepgram live transcription
- TTS: Cartesia streaming TTS
- Memory/cache: Redis
- Persistence: Postgres + Drizzle ORM

## Architecture

High-level flow:

1. Client streams audio to `/ws`
2. Deepgram emits interim/final transcripts
3. When speech-final fires, the backend triggers the LLM
4. The LLM reasons over:
   - active session memory from Redis
   - prior chat turns from Redis
   - cross-session patient context from Postgres
5. The LLM calls tools for availability, booking, rescheduling, cancellation, or doctor lookup
6. Text tokens stream back immediately
7. Text is chunked into phrase-sized units and sent to TTS
8. Audio streams back to the client, with interruption support

Mermaid source for the diagram is in [docs/architecture.mmd](/d:/multlingual/docs/architecture.mmd).

## Memory design

### Short-term memory

Stored in Redis with TTL:

- `chat:<sessionId>`: rolling conversation history
- `session-memory:<sessionId>`: structured state
- `session:<sessionId>`: lightweight compatibility metadata

Structured session memory tracks:

- language
- mode (`inbound` or `outbound`)
- patient identity
- current intent
- conversation stage
- pending confirmation
- most recent availability query
- campaign context
- last tool result summary

This lets the agent avoid re-asking known details and continue naturally after tool calls.

### Long-term memory

Stored in Postgres:

- patients
- appointments
- outbound campaigns and targets
- archived transcripts

When a patient is recognized, the prompt includes recent appointment history and language preference.

## Scheduling and conflict management

The booking engine now validates more than simple doctor collision:

- rejects past date/time
- rejects invalid datetime strings
- ensures requested slot exists in the doctor schedule
- ensures the slot is still exposed by live availability
- prevents doctor double-booking
- prevents same-patient same-time overlap
- returns alternative slots and dates when needed

## Outbound campaigns

Campaign records already exist in the database model. The backend now also exposes:

- `POST /api/sessions/outbound`

This bootstraps an outbound conversation session with patient identity, campaign context, and preferred language so the client can place a reminder or follow-up call using `/ws?sessionId=...&mode=outbound`.

## Latency instrumentation

`LatencyTracer` measures:

- STT end -> first LLM token
- first LLM token -> first TTS byte
- end-to-end speech end -> first audio byte

The target budget is `450ms`, and each traced turn logs `PASS` or `MISS` against that target.

## Local setup

1. Start Redis and Postgres
2. Configure `.env` for:
   - `PORT`
   - `DATABASE_URL`
   - `REDIS_URL`
   - `DEEPGRAM_API_KEY`
   - `GROQ_API_KEY`
   - `CARTESIA_API_KEY`
   - `CARTESIA_VOICE_EN`
   - `CARTESIA_VOICE_HI`
   - `CARTESIA_VOICE_TA`
3. Install backend deps in `backend`
4. Run schema push and seed
5. Start the backend

Commands:

```bash
cd backend
npm install
npm run db:push
npm run db:seed
npm run dev
```

## Key APIs

- `GET /health`
- `POST /api/campaigns`
- `POST /api/campaigns/:id/start`
- `GET /api/campaigns/:id/status`
- `POST /api/sessions/outbound`
- `GET /ws`

## Known limitations

- No frontend/call-control client is included yet
- Outbound campaign execution is still queue-lite and not backed by a true worker
- No explicit VAD layer before STT
- No horizontal scaling coordinator for websocket affinity
- No automated test suite yet
- Architecture diagram is committed as Mermaid source, not rendered PNG/PDF

## Suggested next steps

- Add a Python worker for outbound dialer orchestration and campaign scheduling
- Introduce Redis Streams or a job queue for campaign execution
- Add a real telephony adapter (Twilio/Exotel/etc.)
- Add eval conversations for English/Hindi/Tamil flows
- Persist latency histograms for dashboarding
- Add transaction-safe booking under higher concurrency
