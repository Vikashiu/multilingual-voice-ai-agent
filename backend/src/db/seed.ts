import { db } from './index';
import { doctors, doctorAvailability, patients } from './schema';

async function seed() {
    console.log('Seeding database...');

    // --- Doctors ---
    const insertedDoctors = await db.insert(doctors).values([
        { name: 'Dr. Arun Sharma', specialty: 'cardiologist', languagesSpoken: ['en', 'hi'] },
        { name: 'Dr. Priya Nair', specialty: 'dermatologist', languagesSpoken: ['en', 'ta'] },
        { name: 'Dr. Rajesh Patel', specialty: 'general_physician', languagesSpoken: ['en', 'hi'] },
        { name: 'Dr. Meena Subramaniam', specialty: 'pediatrician', languagesSpoken: ['en', 'ta', 'hi'] },
        { name: 'Dr. Vikram Singh', specialty: 'orthopedist', languagesSpoken: ['en', 'hi'] },
        { name: 'Dr. Lakshmi Iyer', specialty: 'gynecologist', languagesSpoken: ['en', 'ta'] },
    ]).returning();

    console.log(`Inserted ${insertedDoctors.length} doctors`);

    // --- Availability: Mon-Fri 09:00-17:00 for all doctors ---
    const availabilityRows = [];
    for (const doc of insertedDoctors) {
        // Monday (1) through Friday (5)
        for (let day = 1; day <= 5; day++) {
            availabilityRows.push({
                doctorId: doc.id,
                dayOfWeek: day,
                startTime: '09:00',
                endTime: '17:00',
                slotDurationMinutes: 30,
            });
        }
    }

    // Saturday half-day for some doctors
    const saturdayDoctors = insertedDoctors.filter(d =>
        ['general_physician', 'pediatrician'].includes(d.specialty)
    );
    for (const doc of saturdayDoctors) {
        availabilityRows.push({
            doctorId: doc.id,
            dayOfWeek: 6, // Saturday
            startTime: '09:00',
            endTime: '13:00',
            slotDurationMinutes: 30,
        });
    }

    await db.insert(doctorAvailability).values(availabilityRows);
    console.log(`Inserted ${availabilityRows.length} availability slots`);

    // --- Sample patients ---
    const insertedPatients = await db.insert(patients).values([
        { name: 'Amit Kumar', phone: '9876543210', preferredLanguage: 'en' },
        { name: 'Priya Devi', phone: '9876543211', preferredLanguage: 'hi' },
        { name: 'Muthu Krishnan', phone: '9876543212', preferredLanguage: 'ta' },
    ]).returning();

    console.log(`Inserted ${insertedPatients.length} patients`);
    console.log('Seed complete!');
    process.exit(0);
}

seed().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
});
