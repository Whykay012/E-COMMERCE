// src/components/TopProducts.jsx
import React from "react";
import PropTypes from "prop-types";
import { Link } from "react-router-dom";

export default function TopProducts({ products = [], loading = false }) {
  const hasData = products && products.length > 0;

  return (
    <div>
      <h3 className="font-semibold text-gray-700 mb-3">Top Selling Products</h3>

      {/* ───────────────────────────── */}
      {/* Loading Skeleton */}
      {/* ───────────────────────────── */}
      {loading && (
        <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, idx) => (
            <div
              key={idx}
              className="h-44 bg-gray-200 rounded-2xl animate-pulse"
            ></div>
          ))}
        </div>
      )}

      {/* ───────────────────────────── */}
      {/* No Products */}
      {/* ───────────────────────────── */}
      {!loading && !hasData && (
        <p className="text-gray-500 text-sm">No top products to display.</p>
      )}

      {/* ───────────────────────────── */}
      {/* Products Grid */}
      {/* ───────────────────────────── */}
      {!loading && hasData && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {products.map((p) => (
            <div
              key={p.id}
              className="p-4 bg-white rounded-2xl shadow flex flex-col transition hover:shadow-lg hover:-translate-y-1"
            >
              <img
                src={p.image || "/placeholder-product.png"}
                alt={p.name}
                className="h-28 w-full object-cover rounded-lg mb-3"
              />

              <div className="font-semibold text-gray-700 line-clamp-1">
                {p.name}
              </div>

              <div className="text-sm text-gray-600 mt-1">
                ₦{Number(p.price || 0).toLocaleString()}
              </div>

              <div className="text-xs text-emerald-600 font-medium mt-1">
                {p.sales || 0} sold
              </div>

              {/* CTA Button */}
              <Link
                to={`/product/${p.id}`}
                className="mt-3 text-center text-sm px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition"
              >
                View Product
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

TopProducts.propTypes = {
  products: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string,
      image: PropTypes.string,
      price: PropTypes.number,
      sales: PropTypes.number,
    })
  ),
  loading: PropTypes.bool,
};
