// backend/seeders/productSeeder.js
const Product = require("../model/product");
const User = require("../model/userModel");
const { faker } = require("@faker-js/faker");

// Categories and their respective subCategories
const categoryMap = {
  Electronics: [
    "Phones",
    "Laptops",
    "Tablets",
    "Cameras",
    "Headphones",
    "Televisions",
    "Speakers",
    "Wearables",
    "Gaming Consoles",
    "Chargers & Cables",
    "Memory Cards",
    "Monitors",
    "Printers",
    "Smart Home Devices",
    "Drones",
    "Projectors",
    "VR Devices",
    "Networking",
    "Power Banks",
    "Electronics Accessories",
  ],
  Fashion: [
    "Men Shoes",
    "Women Shoes",
    "Men Caps",
    "Women Caps",
    "Men Bags",
    "Women Bags",
    "Men Glasses",
    "Women Glasses",
    "Men Shirts",
    "Women Shirts",
    "Trousers",
    "Skirts",
    "Gowns",
    "Belts",
    "Ties",
    "Jackets",
    "Hoodies & Sweatshirts",
    "Shorts",
    "Socks & Hosiery",
    "Other Fashion",
  ],
  Food: [
    "Snacks",
    "Beverages",
    "Dairy",
    "Bakery",
    "Fruits",
    "Vegetables",
    "Meat",
    "Seafood",
    "Canned Goods",
    "Condiments",
    "Spices",
    "Frozen Foods",
    "Grains & Pulses",
    "Oils & Fats",
    "Breakfast Foods",
    "Noodles & Pasta",
    "Sauces",
    "Sweets & Chocolates",
    "Tea & Coffee",
    "Other Food",
  ],
  Books: [
    "Fiction",
    "Non-Fiction",
    "Science",
    "History",
    "Biography",
    "Comics",
    "Children",
    "Education",
    "Art",
    "Religion",
    "Technology",
    "Business",
    "Travel",
    "Cooking",
    "Health & Fitness",
    "Self-Help",
    "Poetry",
    "Mystery & Thriller",
    "Fantasy & Sci-Fi",
    "Other Books",
  ],
  Health: [
    "Supplements",
    "Vitamins",
    "First Aid",
    "Personal Care",
    "Fitness Equipment",
    "Medical Devices",
    "Skin Care",
    "Hair Care",
    "Oral Care",
    "Baby Care",
    "Weight Management",
    "Immunity Boosters",
    "Pain Relief",
    "Men's Health",
    "Women's Health",
    "Eye Care",
    "Diabetes Care",
    "Nutrition",
    "Wellness",
    "Other Health",
  ],
  Other: [
    "Miscellaneous",
    "Toys",
    "Stationery",
    "Tools",
    "Home Decor",
    "Gardening",
    "Automotive",
    "Pet Supplies",
    "Travel",
    "Office Supplies",
    "Kitchenware",
    "Furniture",
    "Cleaning Supplies",
    "Outdoor Gear",
    "Bags & Luggage",
    "Music Instruments",
    "Craft Supplies",
    "Other Items",
  ],
};

const seedProducts = async (numProducts = 50) => {
  try {
    const admin = await User.findOne({ role: "admin" });
    if (!admin) throw new Error("Admin user not found. Seed admin first.");

    const products = [];

    for (let i = 0; i < numProducts; i++) {
      const category = faker.helpers.arrayElement(Object.keys(categoryMap));
      const subCategory = faker.helpers.arrayElement(categoryMap[category]);

      // Generate 1-5 random images per product
      const numImages = faker.number.int({ min: 1, max: 5 });
      const images = Array.from({ length: numImages }, () => ({
        url: `https://picsum.photos/seed/${faker.string.uuid()}/400/400`,
        public_id: faker.string.uuid(),
      }));

      const product = new Product({
        name: faker.commerce.productName(),
        description: faker.commerce.productDescription(),
        price: faker.number.float({ min: 10, max: 1000, precision: 0.01 }),
        category,
        subCategory,
        stock: faker.number.int({ min: 0, max: 100 }),
        images,
        createdBy: admin._id,
        isFeatured: faker.datatype.boolean(),
        discount: faker.number.int({ min: 0, max: 50 }),
        status: "active",
      });

      products.push(product);
    }

    await Product.insertMany(products);
    console.log(`✅ ${numProducts} products seeded successfully!`);
  } catch (error) {
    console.error("❌ Product seeding failed:", error);
  }
};

module.exports = { seedProducts };
