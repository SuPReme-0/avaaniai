import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const user = request.cookies.get('user') || false; // Or use localStorage check in client components
  
  // Note: Middleware runs on edge, so it can't read localStorage.
  // We handle auth redirection in app/page.tsx, but this is a placeholder 
  // if you decide to move to Cookie-based auth later.
  return NextResponse.next();
}