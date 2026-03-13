import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { outboundCampaigns, campaignTargets, patients, appointments, doctors } from '../db/schema';

export class CampaignService {

    static async createCampaign(
        name: string,
        type: string,
        targets: { patientId: number; appointmentId?: number }[],
    ) {
        const [campaign] = await db.insert(outboundCampaigns).values({
            name,
            type,
            status: 'pending',
        }).returning();

        if (targets.length > 0) {
            await db.insert(campaignTargets).values(
                targets.map(t => ({
                    campaignId: campaign.id,
                    patientId: t.patientId,
                    appointmentId: t.appointmentId || null,
                    status: 'pending',
                }))
            );
        }

        return campaign;
    }

    static async startCampaign(campaignId: number) {
        // Mark campaign as in_progress
        await db.update(outboundCampaigns)
            .set({ status: 'in_progress' })
            .where(eq(outboundCampaigns.id, campaignId));

        // Get all pending targets
        const targets = await db.select({
            targetId: campaignTargets.id,
            patientId: campaignTargets.patientId,
            appointmentId: campaignTargets.appointmentId,
            patientName: patients.name,
            patientPhone: patients.phone,
            patientLang: patients.preferredLanguage,
        })
            .from(campaignTargets)
            .innerJoin(patients, eq(campaignTargets.patientId, patients.id))
            .where(and(
                eq(campaignTargets.campaignId, campaignId),
                eq(campaignTargets.status, 'pending'),
            ));

        for (const target of targets) {
            try {
                // Load appointment details if present
                let appointmentInfo = '';
                if (target.appointmentId) {
                    const [appt] = await db.select({
                        appointmentAt: appointments.appointmentAt,
                        doctorName: doctors.name,
                        doctorSpecialty: doctors.specialty,
                    })
                        .from(appointments)
                        .innerJoin(doctors, eq(appointments.doctorId, doctors.id))
                        .where(eq(appointments.id, target.appointmentId));

                    if (appt) {
                        appointmentInfo = `Appointment with ${appt.doctorName} (${appt.doctorSpecialty}) on ${new Date(appt.appointmentAt).toLocaleString()}`;
                    }
                }

                // Mark as called
                await db.update(campaignTargets)
                    .set({
                        status: 'called',
                        calledAt: new Date(),
                        callResult: `Outbound call queued for ${target.patientName}. ${appointmentInfo}`,
                    })
                    .where(eq(campaignTargets.id, target.targetId));

                console.log(`[CAMPAIGN] Called ${target.patientName} (${target.patientPhone}) - ${appointmentInfo || 'general follow-up'}`);

            } catch (err) {
                await db.update(campaignTargets)
                    .set({ status: 'failed', callResult: String(err) })
                    .where(eq(campaignTargets.id, target.targetId));
            }
        }

        // Mark campaign complete
        await db.update(outboundCampaigns)
            .set({ status: 'completed', completedAt: new Date() })
            .where(eq(outboundCampaigns.id, campaignId));
    }

    static async getCampaignStatus(campaignId: number) {
        const [campaign] = await db.select().from(outboundCampaigns)
            .where(eq(outboundCampaigns.id, campaignId));

        if (!campaign) return { error: 'Campaign not found' };

        const targets = await db.select({
            id: campaignTargets.id,
            patientName: patients.name,
            status: campaignTargets.status,
            callResult: campaignTargets.callResult,
            calledAt: campaignTargets.calledAt,
        })
            .from(campaignTargets)
            .innerJoin(patients, eq(campaignTargets.patientId, patients.id))
            .where(eq(campaignTargets.campaignId, campaignId));

        return { campaign, targets };
    }
}
