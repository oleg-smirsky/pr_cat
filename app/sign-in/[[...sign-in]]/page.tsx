"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GitHubSignInButton } from "@/components/ui/github-signin-button";
import { IconLoader2 } from "@tabler/icons-react";

const isTokenMode = process.env.NEXT_PUBLIC_AUTH_MODE === "token";

export default function SignInPage() {
  const [autoSigningIn, setAutoSigningIn] = useState(isTokenMode);

  useEffect(() => {
    if (!isTokenMode) return;

    signIn("credentials", { redirect: true, callbackUrl: "/dashboard" }).catch(
      (error) => {
        console.error("Token mode auto-sign-in failed:", error);
        setAutoSigningIn(false);
      }
    );
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign In</CardTitle>
          <CardDescription>Sign in to access your account</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {autoSigningIn ? (
              <div className="flex items-center justify-center gap-2 py-4 text-muted-foreground">
                <IconLoader2 size={20} className="animate-spin" />
                <span>Signing in...</span>
              </div>
            ) : (
              <GitHubSignInButton />
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
