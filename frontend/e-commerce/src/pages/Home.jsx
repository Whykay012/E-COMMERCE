import { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { fetchProducts } from "../redux/slices/productSlice";
import { addToCart } from "../redux/slices/cartSlice";

const Home = () => {
  const dispatch = useDispatch();
  const { products, loading, error } = useSelector(
    (state) => state.products || {}
  );

  useEffect(() => {
    dispatch(fetchProducts({ page: 1, limit: 20 })); // fetch first page
  }, [dispatch]);

  if (loading) return <p className="text-center mt-10">Loading products...</p>;
  if (error) return <p className="text-red-500 text-center mt-10">{error}</p>;

  return (
    <div className="p-6 grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
      {products?.map((item) => (
        <div key={item._id} className="bg-white shadow rounded-xl p-4">
          <img
            src={item.image}
            alt={item.name}
            className="h-40 w-full object-cover rounded-lg"
          />
          <h3 className="mt-3 font-bold text-lg">{item.name}</h3>
          <p className="text-gray-500 mb-2">${item.price}</p>
          <button
            onClick={() => dispatch(addToCart(item))}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          >
            Add to Cart
          </button>
        </div>
      ))}
    </div>
  );
};

export default Home;
