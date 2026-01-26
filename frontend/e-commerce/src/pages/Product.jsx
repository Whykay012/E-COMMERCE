// src/pages/Product.jsx
import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import {
  fetchProductById,
  fetchProducts,
  clearProduct,
} from "../redux/slices/productSlice";
import { addToCart } from "../redux/slices/cartSlice";

const Product = () => {
  const { id } = useParams();
  const dispatch = useDispatch();
  const { product, related, products, loading, error } = useSelector(
    (s) => s.product
  );
  const { user } = useSelector((s) => s.auth);

  const [selectedColor, setSelectedColor] = useState("");
  const [selectedSize, setSelectedSize] = useState("");
  const [qty, setQty] = useState(1);

  useEffect(() => {
    if (id) dispatch(fetchProductById(id));
    else dispatch(fetchProducts({ limit: 20 })); // random fallback
    return () => dispatch(clearProduct());
  }, [dispatch, id]);

  useEffect(() => {
    if (product) {
      if (product.colors?.length) setSelectedColor(product.colors[0]);
      if (product.sizes?.length) setSelectedSize(product.sizes[0]);
    }
  }, [product]);

  const handleAddToCart = () => {
    dispatch(
      addToCart({
        id: product._id || product.id,
        name: product.name,
        price: product.price,
        quantity: qty,
        selectedColor,
        selectedSize,
        image: product.images?.[0] || product.image,
      })
    );
  };

  if (loading)
    return <p className="text-center mt-10 text-gray-600">Loading...</p>;
  if (error) return <p className="text-center mt-10 text-red-500">{error}</p>;

  // 🧱 If no product (random home display)
  if (!id) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <h2 className="text-2xl font-bold mb-6 text-center">
          Explore Our Products
        </h2>
        <div className="grid md:grid-cols-4 sm:grid-cols-2 gap-6">
          {products.map((p) => (
            <Link
              to={`/product/${p._id}`}
              key={p._id}
              className="bg-white shadow-md hover:shadow-lg p-4 rounded-xl transition-all"
            >
              <img
                src={p.images?.[0] || p.image}
                alt={p.name}
                className="w-full h-48 object-cover rounded-lg"
              />
              <h3 className="mt-3 font-semibold text-gray-800 truncate">
                {p.name}
              </h3>
              <p className="text-green-600 font-bold">${p.price}</p>
            </Link>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-12">
      {/* Product Details */}
      <div className="grid md:grid-cols-2 gap-8 bg-white p-6 rounded-2xl shadow">
        <div>
          <img
            src={product.images?.[0] || product.image}
            alt={product.name}
            className="w-full h-96 object-cover rounded-xl shadow-sm"
          />
        </div>

        <div>
          <h1 className="text-3xl font-bold text-gray-900">{product.name}</h1>
          <p className="text-2xl text-green-600 mt-2">
            ${product.price?.toFixed(2)}
          </p>
          <p className="mt-4 text-gray-700">{product.description}</p>

          {product.colors?.length > 0 && (
            <div className="mt-4">
              <label className="font-semibold">Color</label>
              <select
                value={selectedColor}
                onChange={(e) => setSelectedColor(e.target.value)}
                className="border p-2 rounded w-full mt-1"
              >
                {product.colors.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
          )}

          {product.sizes?.length > 0 && (
            <div className="mt-4">
              <label className="font-semibold">Size</label>
              <select
                value={selectedSize}
                onChange={(e) => setSelectedSize(e.target.value)}
                className="border p-2 rounded w-full mt-1"
              >
                {product.sizes.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
          )}

          <div className="mt-6 flex items-center gap-3">
            <div className="flex items-center border rounded">
              <button
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                className="px-3"
              >
                -
              </button>
              <input
                type="number"
                value={qty}
                onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
                className="w-16 text-center border-l border-r"
              />
              <button onClick={() => setQty((q) => q + 1)} className="px-3">
                +
              </button>
            </div>
            <button
              onClick={handleAddToCart}
              className="bg-blue-600 text-white px-6 py-2 rounded-lg shadow hover:bg-blue-700"
            >
              Add to Cart
            </button>
          </div>
        </div>
      </div>

      {/* Related Section */}
      {related?.length > 0 && (
        <div>
          <h2 className="text-xl font-semibold mb-4">You may also like</h2>
          <div className="grid md:grid-cols-5 sm:grid-cols-3 gap-4">
            {related.map((p) => (
              <Link
                to={`/product/${p._id}`}
                key={p._id}
                className="bg-white shadow p-3 rounded-lg hover:shadow-md"
              >
                <img
                  src={p.images?.[0] || p.image}
                  alt={p.name}
                  className="w-full h-40 object-cover rounded"
                />
                <h4 className="mt-2 font-semibold text-sm truncate">
                  {p.name}
                </h4>
                <p className="text-green-600 font-bold text-sm">${p.price}</p>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default Product;
