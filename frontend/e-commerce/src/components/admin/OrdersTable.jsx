// src/components/orders/OrdersTable.jsx
import React, { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import {
  fetchOrders,
  filterByStatus,
  sortOrders,
} from "../../redux/slices/orderSlice";
import OrderDetailModal from "./OrderDetailModal";

export default function OrdersTable() {
  const dispatch = useDispatch();
  const { filtered, loading } = useSelector((state) => state.orders);

  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(10);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedOrder, setSelectedOrder] = useState(null);

  useEffect(() => {
    dispatch(fetchOrders());
  }, [dispatch]);

  const handleSearch = (e) => {
    setSearchTerm(e.target.value);
    setCurrentPage(1);
  };

  const handleStatusFilter = (e) => {
    dispatch(filterByStatus(e.target.value));
    setCurrentPage(1);
  };

  const handleSort = (e) => {
    dispatch(sortOrders(e.target.value));
  };

  // Filter by search term
  const searched = filtered.filter(
    (o) =>
      o._id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      o.customerName?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Pagination
  const totalPages = Math.ceil(searched.length / itemsPerPage);
  const displayed = searched.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  if (loading)
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, idx) => (
          <div
            key={idx}
            className="h-6 bg-gray-200 rounded animate-pulse"
          ></div>
        ))}
      </div>
    );

  return (
    <div className="bg-white p-4 rounded-2xl shadow overflow-x-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <input
          type="text"
          placeholder="Search by Order ID or Customer"
          value={searchTerm}
          onChange={handleSearch}
          className="border p-2 rounded w-full sm:w-1/3"
        />
        <div className="flex gap-2">
          <select onChange={handleStatusFilter} className="border p-2 rounded">
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="delivered">Delivered</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select onChange={handleSort} className="border p-2 rounded">
            <option value="">Sort</option>
            <option value="date-newest">Date newest</option>
            <option value="date-oldest">Date oldest</option>
            <option value="amount-highest">Amount highest</option>
            <option value="amount-lowest">Amount lowest</option>
          </select>
        </div>
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-gray-500 bg-gray-100">
          <tr>
            <th className="p-2">Order #</th>
            <th className="p-2">Customer</th>
            <th className="p-2">Date</th>
            <th className="p-2">Amount</th>
            <th className="p-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {displayed.map((o) => (
            <tr
              key={o._id}
              className="border-t hover:bg-gray-50 cursor-pointer"
              onClick={() => setSelectedOrder(o)}
            >
              <td className="p-2">{o._id}</td>
              <td className="p-2">{o.customerName}</td>
              <td className="p-2">{new Date(o.createdAt).toLocaleString()}</td>
              <td className="p-2 font-semibold">
                ₦{o.totalAmount?.toLocaleString()}
              </td>
              <td className="p-2">{o.orderStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Pagination */}
      <div className="mt-3 flex justify-between items-center">
        <div>
          Page {currentPage} of {totalPages}
        </div>
        <div className="flex gap-2">
          <button
            disabled={currentPage === 1}
            onClick={() => setCurrentPage((p) => p - 1)}
            className="px-3 py-1 border rounded disabled:opacity-50"
          >
            Prev
          </button>
          <button
            disabled={currentPage === totalPages}
            onClick={() => setCurrentPage((p) => p + 1)}
            className="px-3 py-1 border rounded disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </div>

      {/* Order Detail Modal */}
      {selectedOrder && (
        <OrderDetailModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
        />
      )}
    </div>
  );
}
