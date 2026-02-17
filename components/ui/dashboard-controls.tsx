"use client";

import React from "react";
import { RefreshButton } from "@/components/ui/refresh-button";
import { CacheStatus } from "@/components/ui/cache-status";
import { useMetricsSummary } from "@/hooks/use-metrics";

export function DashboardControls() {
  const { data, error, isLoading, isDataComplete } = useMetricsSummary();
  const cacheStatusProps = error
    ? {
        status: "error" as const,
        errorMessage: error instanceof Error ? error.message : "Unknown data loading issue",
      }
    : isLoading
      ? {
          status: "loading" as const,
        }
      : {
          status: "ready" as const,
          completeness: isDataComplete ? "complete" as const : "incomplete" as const,
        };

  return (
    <div className="flex items-center justify-between my-4">
      <div className="flex items-center space-x-4">
        <CacheStatus 
          {...cacheStatusProps}
          lastUpdated={data?.lastUpdated ? new Date(data.lastUpdated) : undefined}
          dataDate={data?.dataUpToDate}
          cacheStrategy={data?.cacheStrategy}
          nextUpdate={data?.nextUpdateDue}
        />
      </div>
      <div className="flex items-center space-x-2">
        <RefreshButton />
      </div>
    </div>
  );
} 
