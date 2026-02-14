"use client";

import { useEffect, useState } from "react";
import AuthPage from "./auth/page";
import Dashboard from "./dashboard/page";

export default function RootPage() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    // Check if user session exists
    const user = localStorage.getItem("user");
    setIsAuthenticated(!!user);
  }, []);

  // Prevent flicker during check
  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return isAuthenticated ? <Dashboard /> : <AuthPage />;
}