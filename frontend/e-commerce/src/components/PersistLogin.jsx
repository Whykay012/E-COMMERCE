// src/components/auth/PersistLogin.jsx
import React, { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { fetchCurrentUser, selectAuthLoading } from "../redux/slices/authSlice";

/**
 * Wrap your top-level Routes (or Admin routes) with <PersistLogin>
 * It will attempt to fetch user from cookie and set auth state before rendering children.
 */
export default function PersistLogin({ children }) {
  const dispatch = useDispatch();
  const loading = useSelector((state) => state.auth.authChecking);

  useEffect(() => {
    // attempt to fetch session if not already loaded
    dispatch(fetchCurrentUser());
  }, [dispatch]);

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center p-8">
        <div>Checking session...</div>
      </div>
    );
  }

  return <>{children}</>;
}
