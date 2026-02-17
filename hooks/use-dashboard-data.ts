import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MetricsSummary, PaginatedResult, PullRequestSummary } from '@/lib/core';

interface DashboardRepository {
  id: string;
  name: string;
  full_name: string;
  organization: {
    id: string;
    name: string;
  };
  is_tracked: boolean;
  private: boolean;
  description: string | null;
}

interface DashboardData {
  user: {
    id: string;
    name: string | null;
    email: string | null;
  };
  organizations: Array<{
    id: string;
    name: string | null;
    role?: string;
  }>;
  primaryOrganization: {
    id: string;
    name: string | null;
  };
  repositories?: DashboardRepository[];
  metricsSummary?: MetricsSummary;
  recentPRs?: PaginatedResult<PullRequestSummary>;
}

interface UseDashboardDataOptions {
  include?: ('repositories' | 'metrics-summary' | 'recent-prs')[];
  autoRefresh?: boolean;
  refreshInterval?: number; // in milliseconds
}

export function useDashboardData(options: UseDashboardDataOptions = {}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const {
    include = [],
    autoRefresh = false,
    refreshInterval = 30000 // 30 seconds
  } = options;
  const includeQuery = useMemo(() => include.join(','), [include]);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      
      // Build query parameters
      const params = new URLSearchParams();
      if (includeQuery.length > 0) {
        params.append('include', includeQuery);
      }

      const response = await fetch(`/api/dashboard/data?${params.toString()}`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch dashboard data: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      
      if (result.error) {
        throw new Error(result.error);
      }

      setData(result);
    } catch (err) {
      console.error('Error fetching dashboard data:', err);
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setLoading(false);
    }
  }, [includeQuery]);

  useEffect(() => {
    void fetchData();

    // Set up auto-refresh if enabled
    let intervalId: ReturnType<typeof setInterval> | null = null;
    if (autoRefresh) {
      intervalId = setInterval(() => {
        void fetchData();
      }, refreshInterval);
    }

    // Cleanup
    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [autoRefresh, fetchData, refreshInterval]);

  const refetch = useCallback(() => {
    setLoading(true);
    void fetchData();
  }, [fetchData]);

  return {
    data,
    loading,
    error,
    refetch
  };
} 
