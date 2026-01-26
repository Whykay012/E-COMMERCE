// src/pages/NotFound.jsx
import React from "react";
import { Link } from "react-router-dom";
import { FaExclamationTriangle } from "react-icons/fa";

const NotFound = () => {
  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen bg-gradient-to-r from-purple-400 via-pink-500 to-red-500 p-4 text-white overflow-hidden">
      {/* Floating Animated Shapes */}
      <div className="absolute top-10 left-10 w-24 h-24 bg-white/10 rounded-full blur-xl animate-floating-slow pointer-events-none"></div>
      <div className="absolute bottom-20 right-10 w-32 h-32 bg-white/10 rounded-full blur-xl animate-floating-fast pointer-events-none"></div>

      {/* Icon */}
      <FaExclamationTriangle className="text-6xl mb-6 animate-bounce" />

      {/* Glassmorphic Card */}
      <div className="backdrop-blur-lg bg-white/20 px-10 py-8 rounded-2xl shadow-xl text-center animate-fade-in">
        <h1 className="text-6xl font-extrabold mb-3 drop-shadow-lg">404</h1>

        <h2 className="text-3xl md:text-4xl font-semibold mb-4">
          Page Not Found
        </h2>

        <p className="text-center max-w-md mb-6">
          Oops! The page you are looking for might have been removed, renamed,
          or is temporarily unavailable.
        </p>

        {/* Button */}
        <Link
          to="/"
          className="px-6 py-3 bg-white text-purple-600 font-bold rounded-lg shadow-lg hover:bg-purple-100 transition duration-300"
        >
          Go Back Home
        </Link>
      </div>

      {/* Background Highlight — FIXED with pointer-events-none */}
      <div className="absolute bottom-0 left-0 w-full h-1/3 bg-white opacity-10 rounded-t-full pointer-events-none"></div>
    </div>
  );
};

export default NotFound;
