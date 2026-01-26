import React, { useState, useEffect, useRef } from "react";
import { STATUS_META } from "../../pages/OrdersPage";

export default function OrdersTable({
  orders,
  loading,
  onOpenOrder,
  onCancelOrder,
  isModalOpen, // NEW → stops keyboard navigation when modal open
  cancellingId, // NEW → for disabling cancel button
}) {
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const tableRef = useRef();

  // ------------------------------
  // KEYBOARD NAVIGATION
  // ------------------------------
  const handleKeyDown = (e) => {
    if (loading || orders.length === 0 || isModalOpen) return;

    switch (e.key) {
      case "ArrowDown":
        setFocusedIndex((prev) => Math.min(prev + 1, orders.length - 1));
        e.preventDefault();
        break;

      case "ArrowUp":
        setFocusedIndex((prev) => Math.max(prev - 1, 0));
        e.preventDefault();
        break;

      case "Home":
        setFocusedIndex(0);
        e.preventDefault();
        break;

      case "End":
        setFocusedIndex(orders.length - 1);
        e.preventDefault();
        break;

      case "Enter":
        if (focusedIndex >= 0) {
          onOpenOrder(orders[focusedIndex].id);
        }
        break;

      case "Escape":
        setFocusedIndex(-1);
        break;

      default:
        break;
    }
  };

  // Auto focus the table wrapper on arrow navigation
  useEffect(() => {
    tableRef.current?.focus();
  }, [focusedIndex]);

  return (
    <div
      tabIndex={0}
      ref={tableRef}
      onKeyDown={handleKeyDown}
      role="table"
      aria-label="Orders Table"
      className="overflow-x-auto border rounded-lg focus:outline-none focus:ring focus:ring-blue-300"
    >
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50" role="rowgroup">
          <tr role="row">
            <th className="px-4 py-2 text-left text-sm font-medium text-gray-500">
              Order ID
            </th>
            <th className="px-4 py-2 text-left text-sm font-medium text-gray-500">
              Status
            </th>
            <th className="px-4 py-2 text-left text-sm font-medium text-gray-500">
              Items
            </th>
            <th className="px-4 py-2 text-left text-sm font-medium text-gray-500">
              Actions
            </th>
          </tr>
        </thead>

        <tbody className="bg-white divide-y divide-gray-200" role="rowgroup">
          {orders.map((order, idx) => {
            const status = STATUS_META[order.status] || {
              label: order.status,
              color: "bg-gray-200 text-gray-800",
            };

            const isFocused = idx === focusedIndex;

            return (
              <tr
                key={order.id}
                role="row"
                tabIndex={0}
                aria-label={`Order ${order.id}`}
                className={`
                  cursor-pointer 
                  hover:bg-gray-50 
                  ${isFocused ? "bg-blue-50 ring-2 ring-blue-300" : ""}
                  focus:bg-blue-50
                `}
                onClick={() => onOpenOrder(order.id)}
              >
                <td className="px-4 py-2 text-sm">{order.id}</td>

                <td className="px-4 py-2">
                  <span
                    className={`px-2 py-1 rounded-full text-xs font-medium ${status.color}`}
                  >
                    {status.label}
                  </span>
                </td>

                <td className="px-4 py-2 text-sm">
                  {order.items?.map((it) => it.name).join(", ")}
                </td>

                <td className="px-4 py-2 text-sm">
                  {order.status !== "cancelled" && (
                    <button
                      aria-label={`Cancel order ${order.id}`}
                      disabled={cancellingId === order.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCancelOrder(order.id);
                      }}
                      className={`
                        px-2 py-1 text-xs border rounded 
                        focus:outline-none focus:ring
                        ${
                          cancellingId === order.id
                            ? "text-gray-400 border-gray-400 cursor-not-allowed"
                            : "text-red-600 border-red-600 hover:bg-red-50"
                        }
                      `}
                    >
                      {cancellingId === order.id ? "Cancelling..." : "Cancel"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}

          {orders.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-center text-gray-500">
                No orders found
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
