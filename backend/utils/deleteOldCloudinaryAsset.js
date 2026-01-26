const CloudinaryService = require("../services/cloudinaryService");

module.exports = async function deleteOldAsset(
 urlOrPublicId,
 resource_type = "image"
) {
 if (!urlOrPublicId) return;
 let publicId = urlOrPublicId;
 try {
  if (typeof urlOrPublicId === "string" && urlOrPublicId.startsWith("http")) {
   const parts = urlOrPublicId.split("/upload/");
   if (parts.length > 1) {
    let tail = parts[1];
    tail = tail.replace(/^v\d+\//, "");
    tail = tail.replace(/\.[a-zA-Z0-9]+$/, "");
    publicId = tail;
   }
  }
  await CloudinaryService.deleteByPublicId(publicId, { resource_type });
 } catch (err) {
  // best-effort
  console.warn("deleteOldAsset failed:", err.message);
 }
};