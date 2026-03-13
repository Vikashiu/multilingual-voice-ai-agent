import { pgTable, serial, varchar, timestamp, json, integer, text, time } from 'drizzle-orm/pg-core';

// --- DOCTORS ---
export const doctors = pgTable('doctors', {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    specialty: varchar('specialty', { length: 100 }).notNull(),
    languagesSpoken: json('languages_spoken').$type<string[]>().default(['en']),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

// --- DOCTOR AVAILABILITY ---
export const doctorAvailability = pgTable('doctor_availability', {
    id: serial('id').primaryKey(),
    doctorId: integer('doctor_id').references(() => doctors.id).notNull(),
    dayOfWeek: integer('day_of_week').notNull(),       // 0=Sun, 6=Sat
    startTime: time('start_time').notNull(),            // "09:00"
    endTime: time('end_time').notNull(),                // "17:00"
    slotDurationMinutes: integer('slot_duration_minutes').default(30).notNull(),
});

// --- PATIENTS ---
export const patients = pgTable('patients', {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    phone: varchar('phone', { length: 20 }).unique(),
    preferredLanguage: varchar('preferred_language', { length: 10 }).default('en'),
    notes: text('notes'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

// --- APPOINTMENTS ---
export const appointments = pgTable('appointments', {
    id: serial('id').primaryKey(),
    patientId: integer('patient_id').references(() => patients.id).notNull(),
    doctorId: integer('doctor_id').references(() => doctors.id).notNull(),
    appointmentAt: timestamp('appointment_at').notNull(),
    durationMinutes: integer('duration_minutes').default(30).notNull(),
    status: varchar('status', { length: 20 }).default('confirmed').notNull(),
    reason: text('reason'),
    cancelledAt: timestamp('cancelled_at'),
    rescheduledFrom: integer('rescheduled_from'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// --- OUTBOUND CAMPAIGNS ---
export const outboundCampaigns = pgTable('outbound_campaigns', {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    type: varchar('type', { length: 50 }).notNull(),
    status: varchar('status', { length: 20 }).default('pending').notNull(),
    scheduledAt: timestamp('scheduled_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const campaignTargets = pgTable('campaign_targets', {
    id: serial('id').primaryKey(),
    campaignId: integer('campaign_id').references(() => outboundCampaigns.id).notNull(),
    patientId: integer('patient_id').references(() => patients.id).notNull(),
    appointmentId: integer('appointment_id').references(() => appointments.id),
    status: varchar('status', { length: 20 }).default('pending').notNull(),
    callResult: text('call_result'),
    calledAt: timestamp('called_at'),
});

// --- CHAT ARCHIVES (unchanged) ---
export const chatArchives = pgTable('chat_archives', {
    id: serial('id').primaryKey(),
    sessionId: varchar('session_id', { length: 255 }).unique().notNull(),
    transcript: json('transcript').notNull(),
    archivedAt: timestamp('archived_at').defaultNow().notNull(),
});
