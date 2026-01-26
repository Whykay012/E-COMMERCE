import React from "react";
import AvatarUploadPage from "./AvatarUploadPage";
import ProductImageUploadPage from "./ProductImageUploadPage";
import ProductVideoUploadPage from "./ProductVideoUploadPage";
import BannerUploadPage from "./BannerUploadPage";

export default function AdminUploadDashboard() {
  return (
    <div className="p-6 space-y-8">
      <h1 className="text-2xl font-bold">Admin Upload Dashboard</h1>

      <section className="bg-white p-4 rounded shadow">
        <h3 className="font-semibold mb-2">Product Images</h3>
        <ProductImageUploadPage />
      </section>

      <section className="bg-white p-4 rounded shadow">
        <h3 className="font-semibold mb-2">Product Video</h3>
        <ProductVideoUploadPage />
      </section>

      <section className="bg-white p-4 rounded shadow">
        <h3 className="font-semibold mb-2">Banner</h3>
        <BannerUploadPage />
      </section>

      <section className="bg-white p-4 rounded shadow">
        <h3 className="font-semibold mb-2">User Avatar</h3>
        <AvatarUploadPage />
      </section>
    </div>
  );
}
