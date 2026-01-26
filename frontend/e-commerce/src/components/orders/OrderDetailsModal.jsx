import React, { useEffect, useRef } from "react";
import { useGetOrderByIdQuery } from "../../redux/slices/dashboardSlice";
import { notifyError } from "../../utils/notify";

export default function OrderDetailsModal({ open, orderId, onClose }) {
  const { data, isLoading, error } = useGetOrderByIdQuery(orderId, {
    skip: !open || !orderId,
  });

  const modalRef = useRef(null);
  const firstFocusableRef = useRef(null);
  const lastFocusableRef = useRef(null);

  useEffect(() => {
    if (error) notifyError("Failed to load order details");
  }, [error]);

  useEffect(() => {
    if (!open) return;

    // Focus the modal on open
    const focusableEls = modalRef.current.querySelectorAll(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
    );
    if (focusableEls.length > 0) {
      firstFocusableRef.current = focusableEls[0];
      lastFocusableRef.current = focusableEls[focusableEls.length - 1];
      firstFocusableRef.current.focus();
    }

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        onClose();
      }
      if (e.key === "Tab") {
        // Focus trap
        if (e.shiftKey) {
          if (document.activeElement === firstFocusableRef.current) {
            e.preventDefault();
            lastFocusableRef.current.focus();
          }
        } else {
          if (document.activeElement === lastFocusableRef.current) {
            e.preventDefault();
            firstFocusableRef.current.focus();
          }
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="order-details-title"
    >
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={modalRef}
        className="relative bg-white w-full max-w-3xl rounded-xl shadow-lg overflow-auto max-h-[90vh] focus:outline-none focus:ring"
      >
        <div className="flex items-center justify-between p-4 border-b">
          <h2 id="order-details-title" className="text-lg font-semibold">
            Order Details
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 focus:outline-none focus:ring"
            aria-label="Close order details modal"
          >
            Close
          </button>
        </div>

        <div className="p-4">
          {isLoading && (
            <div className="text-center py-6 text-gray-500">
              Loading order...
            </div>
          )}
          {!isLoading && !data && (
            <div className="text-center py-6 text-gray-500">
              No details available
            </div>
          )}
          {!isLoading && data && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                <div>
                  <div className="text-sm text-gray-500">Reference</div>
                  <div className="font-medium">
                    {data.reference || data._id}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Status</div>
                  <div className="font-medium">{data.orderStatus}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Total</div>
                  <div className="font-medium">
                    ₦{(data.totalAmount || data.total).toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Placed</div>
                  <div className="font-medium">
                    {new Date(data.createdAt).toLocaleString()}
                  </div>
                </div>
              </div>

              <div className="mb-4">
                <h3 className="font-semibold mb-2">Items</h3>
                <div className="divide-y">
                  {(data.items || []).map((it, idx) => (
                    <div key={idx} className="py-3 flex items-center gap-4">
                      <img
                        src={it.image || "/placeholder.png"}
                        alt={it.name}
                        className="w-16 h-16 object-cover rounded"
                      />
                      <div className="flex-1">
                        <div className="font-medium">{it.name}</div>
                        <div className="text-sm text-gray-500">
                          Qty: {it.quantity} • ₦
                          {(it.price || 0).toLocaleString()}
                        </div>
                      </div>
                      <div className="text-sm font-medium">
                        ₦
                        {(
                          (it.price || 0) * it.quantity -
                          (it.discount || 0)
                        ).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-2 justify-end">
                <a
                  href={`/api/orders/receipt/${data._id}`}
                  className="px-4 py-2 rounded-md border hover:bg-gray-50 focus:outline-none focus:ring"
                >
                  Download Receipt
                </a>
                <button
                  onClick={onClose}
                  className="px-4 py-2 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 focus:outline-none focus:ring"
                >
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
