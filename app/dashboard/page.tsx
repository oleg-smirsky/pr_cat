import { Suspense } from "react"
import { ActionableRecommendations } from "@/components/actionable-recommendations"
import { AppSidebar } from "@/components/app-sidebar"
import { CompactEngineeringMetrics } from "@/components/compact-engineering-metrics"
import { EnhancedCompactEngineeringMetrics } from "@/components/enhanced-compact-engineering-metrics"
import { DashboardHeader } from "@/components/dashboard-header"
import { InvestmentAreaDistribution } from "@/components/investment-area-distribution"
import { EnhancedInvestmentAreaDistribution } from "@/components/enhanced-investment-area-distribution"
import { PRActivityTable } from "@/components/pr-activity-table"
import { SectionCardsEngineering } from "@/components/section-cards-engineering"
import { TeamPerformanceSummary } from "@/components/team-performance-summary"

import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { SetupStatusAlert } from "@/components/ui/setup-status-alert"
import { DemoModeBanner } from "@/components/ui/demo-mode-banner"
import { EnvironmentConfig, ServiceLocator } from "@/lib/core"
import type { CategoryTimeSeriesData, TimeSeriesDataPoint } from "@/lib/core"
import { ErrorBoundary } from "@/components/ui/error-boundary"
import { auth } from "@/auth"
import { ensureUserExists } from "@/lib/user-utils"
import { redirect } from "next/navigation"

// Keep the same sidebar styles as original
const SIDEBAR_STYLES = {
  "--sidebar-width": "calc(var(--spacing) * 72)",
  "--header-height": "calc(var(--spacing) * 12)",
} as React.CSSProperties

// Enable PPR for this route
export const experimental_ppr = true

async function TeamFlowMetricsSection({ organizationId }: { organizationId: string }) {
  let timeSeriesData: TimeSeriesDataPoint[] | null = null

  try {
    const metricsService = await ServiceLocator.getMetricsService()
    timeSeriesData = await metricsService.getTimeSeries(organizationId, 14)
  } catch (error) {
    console.warn("Server-side time series fetch failed:", error)
  }

  if (timeSeriesData && timeSeriesData.length > 0) {
    return <EnhancedCompactEngineeringMetrics initialData={timeSeriesData} />
  }

  return <CompactEngineeringMetrics />
}

async function FocusDistributionSection({ organizationId }: { organizationId: string }) {
  let categoryDistributionData: CategoryTimeSeriesData | null = null

  try {
    const prRepository = await ServiceLocator.getPullRequestRepository()
    categoryDistributionData = await prRepository.getCategoryTimeSeries(organizationId, 30)
  } catch (error) {
    console.warn("Server-side category distribution fetch failed:", error)
  }

  if (categoryDistributionData && categoryDistributionData.data.length > 0) {
    return <EnhancedInvestmentAreaDistribution initialData={categoryDistributionData} />
  }

  return <InvestmentAreaDistribution />
}

export default async function DashboardPage() {
  // Exact same authentication flow as original
  const session = await auth()
  const environmentConfig = EnvironmentConfig.getInstance()
  
  // Check if we're in demo mode for banner display only
  const isDemoMode = environmentConfig.isDemoMode()
  
  // In demo mode, the auth service provides mock sessions automatically
  // In production mode, require real authentication
  if (!isDemoMode && !session?.user) {
    redirect('/sign-in')
  }
  
  // In production mode, ensure user exists in database
  if (!isDemoMode && session?.user) {
    await ensureUserExists(session.user)
  }
  
  // Get organization info for server-side data fetching
  const organizations = session?.organizations || []
  const primaryOrg = organizations[0]
  const orgId = primaryOrg?.id?.toString() || "demo-org-1"
  
  // Setup incomplete only applies to production mode
  const setupIncomplete = !isDemoMode && session?.hasGithubApp === false;

  return (
    <SidebarProvider style={SIDEBAR_STYLES}>
      <AppSidebar variant="inset" />
      <SidebarInset>
        <DashboardHeader pageTitle="Dashboard" />
        
        {isDemoMode && (
          <div className="pt-4 pb-2">
            <DemoModeBanner />
          </div>
        )}
        
        {setupIncomplete && (
          <div className="px-4 pt-4 lg:px-6">
            <SetupStatusAlert />
          </div>
        )}
        

        
        <ErrorBoundary>
          <main className="flex flex-1 flex-col">
            <div className="@container/main flex flex-1 flex-col gap-2">
              <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
                {/* Team Performance Summary - focused on retrospectives */}
                <div className="px-4 lg:px-6">
                  <Suspense fallback={<TeamPerformanceSkeleton />}>
                    <TeamPerformanceSummary />
                  </Suspense>
                </div>

                {/* Main metrics cards - dynamic data */}
                <Suspense fallback={<MetricsCardsSkeleton />}>
                  <SectionCardsEngineering />
                </Suspense>
                
                {/* Recommendations - dynamic data */}
                <div className="px-4 lg:px-6">
                  <Suspense fallback={<RecommendationsSkeleton />}>
                    <ActionableRecommendations />
                  </Suspense>
                </div>
                
                {/* Secondary metrics grid - enhanced with server-side data */}
                <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 md:grid-cols-2">
                  <Suspense fallback={<CompactMetricsSkeleton />}>
                    <TeamFlowMetricsSection organizationId={orgId} />
                  </Suspense>
                  <Suspense fallback={<CompactMetricsSkeleton />}>
                    <FocusDistributionSection organizationId={orgId} />
                  </Suspense>
                </div>
                
                {/* PR Activity table - dynamic data */}
                <Suspense fallback={<TableSkeleton />}>
                  <PRActivityTable />
                </Suspense>
              </div>
            </div>
          </main>
        </ErrorBoundary>
      </SidebarInset>
    </SidebarProvider>
  )
}

// Skeleton components for loading states (same as original)
function MetricsCardsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="bg-card border rounded-lg p-6">
          <div className="space-y-2">
            <div className="h-4 w-24 bg-muted animate-pulse rounded" />
            <div className="h-8 w-20 bg-muted animate-pulse rounded" />
            <div className="h-3 w-32 bg-muted animate-pulse rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}

function CompactMetricsSkeleton() {
  return (
    <div className="bg-card border rounded-lg p-6">
      <div className="space-y-4">
        <div className="h-5 w-32 bg-muted animate-pulse rounded" />
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-4 w-full bg-muted animate-pulse rounded" />
          ))}
        </div>
      </div>
    </div>
  )
}

function TableSkeleton() {
  return (
    <div className="bg-card border rounded-lg p-6 mx-4 lg:mx-6">
      <div className="space-y-4">
        <div className="h-6 w-40 bg-muted animate-pulse rounded" />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 w-full bg-muted animate-pulse rounded" />
          ))}
        </div>
      </div>
    </div>
  )
}

function RecommendationsSkeleton() {
  return (
    <div className="bg-card border rounded-lg p-6">
      <div className="space-y-4">
        <div className="h-6 w-48 bg-muted animate-pulse rounded" />
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 w-full bg-muted animate-pulse rounded" />
          ))}
        </div>
      </div>
    </div>
  )
}

function TeamPerformanceSkeleton() {
  return (
    <div className="bg-card border rounded-lg p-6">
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="h-6 w-48 bg-muted animate-pulse rounded" />
          <div className="h-4 w-64 bg-muted animate-pulse rounded" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-muted/50 p-4 rounded-lg space-y-2">
              <div className="h-4 w-24 bg-muted animate-pulse rounded" />
              <div className="h-8 w-16 bg-muted animate-pulse rounded" />
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <div className="h-4 w-32 bg-muted animate-pulse rounded" />
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 w-full bg-muted animate-pulse rounded" />
          ))}
        </div>
      </div>
    </div>
  )
}
