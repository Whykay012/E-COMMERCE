const User = require("../model/userModel");
const bcrypt = require("bcryptjs");

const seedAdminUser = async () => {
  try {
    const hashedPassword = await bcrypt.hash("admin123", 10);

    const admin = await User.create({
      firstName: "Admin",
      lastName: "User",
      username: "admin",
      email: "admin@example.com",
      password: hashedPassword,
      phone: "08012345678",
      dob: new Date("1990-01-01"),
      country: "Nigeria",
      state: "Lagos",
      address: "1 Admin Street",
      age: 34,
      role: "admin",
    });

    console.log("✅ Admin user created:", admin.email);
    return admin;
  } catch (error) {
    console.error("❌ Admin seeding failed:", error);
    throw error;
  }
};

module.exports = seedAdminUser;
