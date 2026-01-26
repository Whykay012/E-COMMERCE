// src/components/common/Pagination.jsx
import React from "react";
import PropTypes from "prop-types";

export default function Pagination({ page, totalPages, onPageChange }) {
  if (totalPages <= 1) return null;

  const handlePrevious = () => {
    if (page > 1) onPageChange(page - 1);
  };

  const handleNext = () => {
    if (page < totalPages) onPageChange(page + 1);
  };

  const renderPageNumbers = () => {
    const pageNumbers = [];
    const isMobile = window.innerWidth < 640; // Tailwind sm breakpoint

    const start = isMobile ? Math.max(1, page - 2) : 1;
    const end = isMobile ? Math.min(totalPages, page + 2) : totalPages;

    for (let i = start; i <= end; i++) {
      pageNumbers.push(
        <button
          key={i}
          onClick={() => onPageChange(i)}
          className={`px-3 py-1 rounded-md border ${
            i === page
              ? "bg-blue-600 text-white border-blue-600"
              : "bg-white text-gray-700 hover:bg-gray-100"
          }`}
          aria-current={i === page ? "page" : undefined}
        >
          {i}
        </button>
      );
    }

    // Desktop: add first/last with ellipsis
    if (!isMobile && start > 1) {
      pageNumbers.unshift(
        <React.Fragment key="start-ellipsis">
          <button
            onClick={() => onPageChange(1)}
            className="px-3 py-1 rounded-md border bg-white text-gray-700 hover:bg-gray-100"
          >
            1
          </button>
          <span className="px-2 text-gray-400">...</span>
        </React.Fragment>
      );
    }

    if (!isMobile && end < totalPages) {
      pageNumbers.push(
        <React.Fragment key="end-ellipsis">
          <span className="px-2 text-gray-400">...</span>
          <button
            onClick={() => onPageChange(totalPages)}
            className="px-3 py-1 rounded-md border bg-white text-gray-700 hover:bg-gray-100"
          >
            {totalPages}
          </button>
        </React.Fragment>
      );
    }

    return pageNumbers;
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        onClick={handlePrevious}
        disabled={page === 1}
        className="px-3 py-1 rounded-md border bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-50"
        aria-label="Previous page"
      >
        &laquo;
      </button>

      {renderPageNumbers()}

      <button
        onClick={handleNext}
        disabled={page === totalPages}
        className="px-3 py-1 rounded-md border bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-50"
        aria-label="Next page"
      >
        &raquo;
      </button>
    </div>
  );
}

Pagination.propTypes = {
  page: PropTypes.number.isRequired,
  totalPages: PropTypes.number.isRequired,
  onPageChange: PropTypes.func.isRequired,
};
