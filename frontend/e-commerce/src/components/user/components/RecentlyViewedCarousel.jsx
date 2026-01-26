import React from "react";
import { Swiper, SwiperSlide } from "swiper/react";
import "swiper/css";

export default function RecentlyViewedCarousel({ products }) {
  if (!products || !products.length || products[0].message) {
    return (
      <p className="text-center text-gray-400 py-6">
        {products?.[0]?.message || "No recently viewed products"}
      </p>
    );
  }

  return (
    <div className="bg-white p-4 rounded-xl shadow">
      <h3 className="font-semibold mb-4">Recently Viewed</h3>
      <Swiper
        spaceBetween={10}
        slidesPerView={2}
        breakpoints={{ 640: { slidesPerView: 3 }, 1024: { slidesPerView: 5 } }}
      >
        {products.map((p) => (
          <SwiperSlide key={p._id}>
            <img
              src={p.image || "/placeholder.png"}
              alt={p.name}
              className="rounded-lg w-full h-32 object-cover"
            />
          </SwiperSlide>
        ))}
      </Swiper>
    </div>
  );
}
