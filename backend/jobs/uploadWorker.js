// jobs/uploadWorker.js
const { Worker } = require("bullmq");
const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
};
const CloudinaryService = require("../services/cloudinaryService");
const Product = require("../model/product");
const logger = require("../config/logger");

const worker = new Worker(
  "uploads",
  async (job) => {
    if (job.name === "product-images") {
      const { files, productId } = job.data;
      const product = await Product.findById(productId);
      if (!product) throw new Error("Product not found in upload worker");

      const uploaded = [];
      for (const f of files) {
        const res = await CloudinaryService.uploadBuffer(
          Buffer.from(f.buffer),
          { folder: "ecommerce/products/images" }
        );
        uploaded.push({ url: res.secure_url, public_id: res.public_id });
        product.images = product.images || [];
        product.images.push({ url: res.secure_url, public_id: res.public_id });
      }
      await product.save();
      return { uploadedCount: uploaded.length };
    }
  },
  { connection }
);

worker.on("completed", (job) => logger.info(`Job ${job.id} completed`));
worker.on("failed", (job, err) =>
  logger.error(`Job ${job.id} failed: ${err.message}`)
);

module.exports = worker;
