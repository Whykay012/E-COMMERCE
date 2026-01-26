const seedAdminUser = require("./adminSeeder.js");
const { seedProducts } = require("./productSeeder.js");
const connectDB = require("../config/connect.js");

connectDB();

const runSeeder = async () => {
  try {
    console.log("🌱 Seeding data...");

    await seedAdminUser();
    await seedProducts(50);

    console.log("🌱 Database seeding completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Seeding error:", error);
    process.exit(1);
  }
};

runSeeder();
