"use client";

import { useSession } from "next-auth/react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";

export function GitHubOrganizationsCard() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (

          <div className="text-muted-foreground">Loading organizations...</div>

    );
  }

  if (!session?.organizations || session.organizations.length === 0) {
    return (

          <div className="text-muted-foreground">
            No organizations found.
          </div>

    );
  }

  return (


        <div className="flex flex-col gap-3">
          {session.organizations.map((org) => (
            <div key={org.github_id || org.id} className="flex items-center gap-3">
              <Avatar className="size-8">
                <AvatarImage src={org.avatar_url ?? undefined} alt={org.name} />
                <AvatarFallback>{org.name[0]}</AvatarFallback>
              </Avatar>
              <div className="flex flex-col">
                <span className="font-medium">{org.name}</span>
                <a
                  href={`https://github.com/orgs/${org.name}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline text-xs"
                >
                  View on GitHub
                </a>
              </div>
            </div>
          ))}
        </div>
 
  );
} 
