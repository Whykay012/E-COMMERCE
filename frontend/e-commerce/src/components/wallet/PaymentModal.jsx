// src/components/Wallet/PaymentModal.jsx
import React, { useEffect, useRef, useState } from "react";
import { notifyError, notifySuccess } from "../../utils/notify";
import {
  useInitializePaymentMutation,
  useVerifyPaymentQuery,
} from "../../redux/slices/dashboardApiSlice";

export default function PaymentModal({ open, paymentId, onClose }) {
  const modalRef = useRef(null);
  const [initializePayment] = useInitializePaymentMutation();
  const [verifying, setVerifying] = useState(false);
  const [paymentData, setPaymentData] = useState(null);

  // Focus trap inside modal
  useEffect(() => {
    if (!open) return;
    const focusableElements =
      modalRef.current.querySelectorAll("button, [tabindex]");
    const firstEl = focusableElements[0];
    const lastEl = focusableElements[focusableElements.length - 1];

    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        if (e.shiftKey) {
          if (document.activeElement === firstEl) {
            e.preventDefault();
            lastEl.focus();
          }
        } else {
          if (document.activeElement === lastEl) {
            e.preventDefault();
            firstEl.focus();
          }
        }
      }
    };

    modalRef.current.addEventListener("keydown", handleKey);
    firstEl?.focus();
    return () => modalRef.current.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  const handlePayment = async () => {
    try {
      setVerifying(true);
      const { data } = await initializePayment(paymentId).unwrap();
      setPaymentData(data);
      notifySuccess("Payment initialized. Complete payment in popup.");
    } catch (err) {
      notifyError(err?.data?.message || "Failed to initialize payment");
    } finally {
      setVerifying(false);
    }
  };

  const handleVerify = async () => {
    try {
      setVerifying(true);
      const { data } = await useVerifyPaymentQuery(paymentId);
      setPaymentData(data);
      notifySuccess("Payment verified successfully");
    } catch (err) {
      notifyError(err?.data?.message || "Failed to verify payment");
    } finally {
      setVerifying(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
      <div
        ref={modalRef}
        className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md focus:outline-none"
        tabIndex={-1}
      >
        <h3 className="text-lg font-semibold mb-4">Payment Details</h3>
        {paymentData ? (
          <div className="space-y-2">
            <div>ID: {paymentData.id}</div>
            <div>Status: {paymentData.status}</div>
            <div>Amount: ₦{paymentData.amount?.toLocaleString()}</div>
          </div>
        ) : (
          <p className="text-gray-500">Click below to initialize payment</p>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300"
            onClick={onClose}
          >
            Close
          </button>
          {!paymentData?.status && (
            <button
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              onClick={handlePayment}
              disabled={verifying}
            >
              {verifying ? "Processing..." : "Initialize Payment"}
            </button>
          )}
          {paymentData?.status === "pending" && (
            <button
              className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
              onClick={handleVerify}
              disabled={verifying}
            >
              {verifying ? "Verifying..." : "Verify Payment"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
