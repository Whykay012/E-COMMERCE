import React, {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
} from "react";
import WalletCards from "../components/Wallet/WalletCards";
import PaymentHistoryTable from "../components/Wallet/PaymentHistoryTable";
import PaymentModal from "../components/Wallet/PaymentModal";
import Pagination from "../components/common/Pagination";
import { io } from "../socket/socket";
import { notifyError, notifySuccess } from "../utils/notify";
import {
  useGetWalletQuery,
  useGetPaymentHistoryQuery,
} from "../redux/slices/dashboardApiSlice";

export default function WalletPage() {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedPaymentId, setSelectedPaymentId] = useState(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const tableRef = useRef(null);

  // Debounce search to avoid excessive API calls
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1); // Reset to first page on search
    }, 500);

    return () => clearTimeout(handler);
  }, [search]);

  // Fetch wallet
  const {
    data: walletData,
    error: walletError,
    refetch: refetchWallet,
  } = useGetWalletQuery();

  // Fetch payments with filters
  const {
    data: paymentsData,
    error: paymentsError,
    isLoading,
    refetch: refetchPayments,
  } = useGetPaymentHistoryQuery(
    {
      page,
      limit,
      status: statusFilter === "all" ? undefined : statusFilter,
      search: debouncedSearch || undefined,
    },
    { pollingInterval: 10000 }
  );

  // Show notifications on errors
  useEffect(() => {
    if (walletError)
      notifyError(walletError?.data?.message || "Failed to load wallet");
    if (paymentsError)
      notifyError(paymentsError?.data?.message || "Failed to load payments");
  }, [walletError, paymentsError]);

  // Socket.io live updates
  useEffect(() => {
    io.on("walletUpdated", () => {
      notifySuccess("Wallet updated");
      refetchWallet();
      refetchPayments();
    });
    return () => io.off("walletUpdated");
  }, [refetchWallet, refetchPayments]);

  const paymentsRaw = paymentsData?.payments || [];
  const totalCount = paymentsData?.count || 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));

  // Filter payments locally for better responsiveness
  const filteredPayments = useMemo(() => {
    let list = Array.isArray(paymentsRaw) ? paymentsRaw : [];
    if (statusFilter !== "all")
      list = list.filter((p) => p.status === statusFilter);
    return list;
  }, [paymentsRaw, statusFilter]);

  const openPayment = (id) => setSelectedPaymentId(id);
  const closePayment = () => setSelectedPaymentId(null);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e) => {
      if (!filteredPayments.length) return;
      if (e.key === "ArrowDown") {
        setHighlightedIndex((i) => (i + 1) % filteredPayments.length);
      } else if (e.key === "ArrowUp") {
        setHighlightedIndex(
          (i) => (i - 1 + filteredPayments.length) % filteredPayments.length
        );
      } else if (e.key === "Enter") {
        if (highlightedIndex >= 0)
          openPayment(filteredPayments[highlightedIndex]._id);
      } else if (e.key === "ArrowLeft") {
        setPage((p) => Math.max(1, p - 1));
      } else if (e.key === "ArrowRight") {
        setPage((p) => Math.min(totalPages, p + 1));
      }
    },
    [filteredPayments, highlightedIndex, totalPages]
  );

  useEffect(() => {
    const current = tableRef.current;
    current?.addEventListener("keydown", handleKeyDown);
    return () => current?.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Format currency
  const formatCurrency = (amount) =>
    new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency: "NGN",
    }).format(amount);

  return (
    <div
      ref={tableRef}
      tabIndex={0}
      className="p-4 sm:p-6 lg:p-8 space-y-6 outline-none"
    >
      <WalletCards
        wallet={{ ...walletData, balance: walletData?.balance || 0 }}
      />

      <section>
        <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-xl font-semibold">Payment History</h2>
            <p className="text-sm text-gray-500">Track all your transactions</p>
          </div>
          <div className="flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto">
            <input
              type="search"
              placeholder="Search by reference or description..."
              className="w-full sm:w-64 px-3 py-2 rounded-lg border focus:ring focus:outline-none"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-2 rounded-lg border"
            >
              {["all", "pending", "success", "failed"].map((s) => (
                <option value={s} key={s}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="px-3 py-2 rounded-lg border"
            >
              {[5, 10, 20, 50].map((n) => (
                <option value={n} key={n}>
                  {n} / page
                </option>
              ))}
            </select>
          </div>
        </header>

        {isLoading ? (
          <div className="text-center py-10">Loading payments...</div>
        ) : (
          <>
            <PaymentHistoryTable
              payments={filteredPayments}
              highlightedIndex={highlightedIndex}
              onOpenPayment={openPayment}
              formatCurrency={formatCurrency}
            />
            <div className="flex items-center justify-between mt-4 flex-wrap gap-2">
              <div className="text-sm text-gray-500">
                Showing {filteredPayments.length} of {totalCount} payments
              </div>
              <Pagination
                page={page}
                totalPages={totalPages}
                onPageChange={setPage}
              />
            </div>
          </>
        )}
      </section>

      {selectedPaymentId && (
        <PaymentModal
          open={!!selectedPaymentId}
          paymentId={selectedPaymentId}
          onClose={closePayment}
        />
      )}
    </div>
  );
}
