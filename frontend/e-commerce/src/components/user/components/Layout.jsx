// src/components/Layout/Layout.jsx
import { Outlet } from "react-router-dom";
import Navbar from "../../NavBar";
import Footer from "../../Footer";
import { Suspense } from "react";
import ErrorBoundary from "../../ErrorBoundaries";

export default function Layout() {
  return (
    <div className="flex flex-col min-h-screen">
      <Navbar />
      <main className="flex-1">
        <ErrorBoundary>
          <Suspense
            fallback={<div className="text-center py-10">Loading...</div>}
          >
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
      <Footer />
    </div>
  );
}
