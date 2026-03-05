"use client"

import * as React from "react"
import { useSession } from "next-auth/react"
import { IconDownload, IconDeviceFloppy } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group"

// --- Types ---

interface MonthlyBreakdown {
  month: string
  allocations: Array<{
    project: { id: number; name: string } | null
    commits: number
    percentage: number
  }>
  totalCommits: number
}

interface ProjectAllocationResult {
  month: string
  monthEnd?: string
  team: { id: number; name: string } | null
  allocations: Array<{
    project: { id: number; name: string } | null
    commits: number
    percentage: number
  }>
  totalCommits: number
  monthlyBreakdowns?: MonthlyBreakdown[]
}

interface TeamCostData {
  id?: number
  teamId: number
  month: string
  totalCost: number
  headcount: number
  currency: string
}

interface Team {
  id: number
  name: string
}

// --- Helpers ---

function getCurrentMonth(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  return `${year}-${month}`
}

function expandMonths(start: string, end: string): string[] {
  const months: string[] = []
  const [sy, sm] = start.split("-").map(Number)
  const [ey, em] = end.split("-").map(Number)
  let y = sy, m = sm
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`)
    m++
    if (m > 12) { m = 1; y++ }
  }
  return months
}

function formatMonthLabel(month: string): string {
  const [year, m] = month.split("-")
  const date = new Date(Number(year), Number(m) - 1)
  return date.toLocaleDateString("en-US", { month: "short", year: "2-digit" })
}

function buildProjectCsvContent(
  data: ProjectAllocationResult,
  monthCosts: Map<string, TeamCostData>
): string {
  if (data.monthlyBreakdowns && data.monthlyBreakdowns.length > 0) {
    return buildMultiMonthCsvContent(data, monthCosts)
  }
  return buildSingleMonthCsvContent(data, monthCosts)
}

function buildSingleMonthCsvContent(
  data: ProjectAllocationResult,
  monthCosts: Map<string, TeamCostData>
): string {
  const cost = monthCosts.get(data.month)
  const teamCost = cost?.totalCost
  const hasCost = teamCost !== undefined && teamCost > 0
  const headers = [
    "Project",
    "Commits",
    "Percentage",
    ...(hasCost ? ["Cost"] : []),
  ]
  const rows: string[][] = []

  for (const alloc of data.allocations) {
    const row = [
      alloc.project?.name ?? "Unallocated",
      String(alloc.commits),
      `${alloc.percentage.toFixed(1)}%`,
      ...(hasCost
        ? [`${((alloc.percentage / 100) * teamCost).toFixed(2)}`]
        : []),
    ]
    rows.push(row)
  }

  // Total row
  const totalRow = [
    "Total",
    String(data.totalCommits),
    "100.0%",
    ...(hasCost ? [`${teamCost.toFixed(2)}`] : []),
  ]
  rows.push(totalRow)

  return formatCsv(headers, rows)
}

function buildMultiMonthCsvContent(
  data: ProjectAllocationResult,
  monthCosts: Map<string, TeamCostData>
): string {
  const breakdowns = data.monthlyBreakdowns!
  const months = breakdowns.map((b) => b.month)

  // Collect all unique projects across all months
  const projectMap = new Map<string, { id: number; name: string } | null>()
  for (const alloc of data.allocations) {
    const key = alloc.project?.id != null ? String(alloc.project.id) : "unallocated"
    if (!projectMap.has(key)) {
      projectMap.set(key, alloc.project)
    }
  }

  // Headers: Project, Month1 %, Month1 Cost, ..., Total Cost, Total %
  const headers = ["Project"]
  for (const m of months) {
    const label = formatMonthLabel(m)
    headers.push(`${label} %`, `${label} Cost`)
  }
  headers.push("Total Cost", "Total %")

  const rows: string[][] = []
  let grandTotalCost = 0

  // First pass: compute per-project total costs for Total % calculation
  const projectTotalCosts = new Map<string, number>()
  for (const [key, project] of projectMap) {
    let projectCostSum = 0
    for (const breakdown of breakdowns) {
      const alloc = breakdown.allocations.find((a) => {
        const aKey = a.project?.id != null ? String(a.project.id) : "unallocated"
        return aKey === key
      })
      const pct = alloc?.percentage ?? 0
      const mc = monthCosts.get(breakdown.month)
      if (mc && mc.totalCost > 0) {
        projectCostSum += (pct / 100) * mc.totalCost
      }
    }
    projectTotalCosts.set(key, projectCostSum)
    grandTotalCost += projectCostSum
  }

  // Second pass: build rows
  for (const [key, project] of projectMap) {
    const row: string[] = [project?.name ?? "Unallocated"]

    for (const breakdown of breakdowns) {
      const alloc = breakdown.allocations.find((a) => {
        const aKey = a.project?.id != null ? String(a.project.id) : "unallocated"
        return aKey === key
      })
      const pct = alloc?.percentage ?? 0
      const mc = monthCosts.get(breakdown.month)
      row.push(`${pct.toFixed(1)}%`)
      if (mc && mc.totalCost > 0) {
        row.push(`${((pct / 100) * mc.totalCost).toFixed(2)}`)
      } else {
        row.push("-")
      }
    }

    const projectCost = projectTotalCosts.get(key) ?? 0
    row.push(projectCost > 0 ? projectCost.toFixed(2) : "-")
    row.push(
      grandTotalCost > 0
        ? `${((projectCost / grandTotalCost) * 100).toFixed(1)}%`
        : "0.0%"
    )
    rows.push(row)
  }

  // Total row
  const totalRow: string[] = ["Total"]
  for (const breakdown of breakdowns) {
    const mc = monthCosts.get(breakdown.month)
    totalRow.push("100.0%")
    totalRow.push(mc && mc.totalCost > 0 ? mc.totalCost.toFixed(2) : "-")
  }
  totalRow.push(grandTotalCost > 0 ? grandTotalCost.toFixed(2) : "-")
  totalRow.push("100.0%")
  rows.push(totalRow)

  return formatCsv(headers, rows)
}

function formatCsv(headers: string[], rows: string[][]): string {
  const escape = (val: string) => {
    if (val.includes(",") || val.includes('"') || val.includes("\n")) {
      return `"${val.replace(/"/g, '""')}"`
    }
    return val
  }

  const csvLines = [headers.map(escape).join(",")]
  for (const row of rows) {
    csvLines.push(row.map(escape).join(","))
  }
  return csvLines.join("\n")
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

// --- Components ---

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex gap-4">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-9 w-48" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  )
}

function SingleMonthProjectTable({
  data,
  teamCost,
}: {
  data: ProjectAllocationResult
  teamCost: number | undefined
}) {
  const hasCost = teamCost !== undefined && teamCost > 0

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead className="text-right">Commits</TableHead>
            <TableHead className="text-right">Percentage</TableHead>
            {hasCost && (
              <TableHead className="text-right">Cost</TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.allocations.map((alloc) => {
            const isUnallocated = alloc.project === null
            return (
              <TableRow key={alloc.project?.id ?? "unallocated"}>
                <TableCell
                  className={
                    isUnallocated
                      ? "text-muted-foreground italic"
                      : "font-medium"
                  }
                >
                  {alloc.project?.name ?? "Unallocated"}
                </TableCell>
                <TableCell className="text-right">
                  {alloc.commits}
                </TableCell>
                <TableCell className="text-right">
                  {alloc.percentage.toFixed(1)}%
                </TableCell>
                {hasCost && (
                  <TableCell className="text-right">
                    {((alloc.percentage / 100) * teamCost).toFixed(2)}
                  </TableCell>
                )}
              </TableRow>
            )
          })}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell className="font-medium">Total</TableCell>
            <TableCell className="text-right font-medium">
              {data.totalCommits}
            </TableCell>
            <TableCell className="text-right font-medium">
              100.0%
            </TableCell>
            {hasCost && (
              <TableCell className="text-right font-medium">
                {teamCost.toFixed(2)}
              </TableCell>
            )}
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  )
}

function MultiMonthProjectTable({
  data,
  monthCosts,
}: {
  data: ProjectAllocationResult
  monthCosts: Map<string, TeamCostData>
}) {
  const breakdowns = data.monthlyBreakdowns!
  const months = breakdowns.map((b) => b.month)

  // Collect all unique projects across the aggregate allocations
  const projects = data.allocations.map((a) => ({
    key: a.project?.id != null ? String(a.project.id) : "unallocated",
    project: a.project,
  }))

  // Pre-compute per-project per-month costs and totals
  const projectCosts = new Map<string, { perMonth: Map<string, number>; total: number }>()
  let grandTotal = 0

  for (const { key } of projects) {
    const perMonth = new Map<string, number>()
    let total = 0
    for (const breakdown of breakdowns) {
      const alloc = breakdown.allocations.find((a) => {
        const aKey = a.project?.id != null ? String(a.project.id) : "unallocated"
        return aKey === key
      })
      const pct = alloc?.percentage ?? 0
      const mc = monthCosts.get(breakdown.month)
      if (mc && mc.totalCost > 0) {
        const cost = (pct / 100) * mc.totalCost
        perMonth.set(breakdown.month, cost)
        total += cost
      }
    }
    projectCosts.set(key, { perMonth, total })
    grandTotal += total
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            {months.map((m) => (
              <React.Fragment key={m}>
                <TableHead className="text-right">
                  {formatMonthLabel(m)} %
                </TableHead>
                <TableHead className="text-right">
                  {formatMonthLabel(m)} Cost
                </TableHead>
              </React.Fragment>
            ))}
            <TableHead className="text-right">Total Cost</TableHead>
            <TableHead className="text-right">Total %</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map(({ key, project }) => {
            const isUnallocated = project === null
            const costs = projectCosts.get(key)!

            return (
              <TableRow key={key}>
                <TableCell
                  className={
                    isUnallocated
                      ? "text-muted-foreground italic"
                      : "font-medium"
                  }
                >
                  {project?.name ?? "Unallocated"}
                </TableCell>
                {breakdowns.map((breakdown) => {
                  const alloc = breakdown.allocations.find((a) => {
                    const aKey = a.project?.id != null ? String(a.project.id) : "unallocated"
                    return aKey === key
                  })
                  const pct = alloc?.percentage ?? 0
                  const mc = monthCosts.get(breakdown.month)
                  const hasMonthlyCost = mc && mc.totalCost > 0

                  return (
                    <React.Fragment key={breakdown.month}>
                      <TableCell className="text-right">
                        {pct.toFixed(1)}%
                      </TableCell>
                      <TableCell className="text-right">
                        {hasMonthlyCost
                          ? ((pct / 100) * mc.totalCost).toFixed(2)
                          : "\u2014"}
                      </TableCell>
                    </React.Fragment>
                  )
                })}
                <TableCell className="text-right font-medium">
                  {costs.total > 0 ? costs.total.toFixed(2) : "\u2014"}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {grandTotal > 0
                    ? `${((costs.total / grandTotal) * 100).toFixed(1)}%`
                    : "0.0%"}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell className="font-medium">Total</TableCell>
            {months.map((m) => {
              const mc = monthCosts.get(m)
              return (
                <React.Fragment key={m}>
                  <TableCell className="text-right font-medium">
                    100.0%
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {mc && mc.totalCost > 0 ? mc.totalCost.toFixed(2) : "\u2014"}
                  </TableCell>
                </React.Fragment>
              )
            })}
            <TableCell className="text-right font-medium">
              {grandTotal > 0 ? grandTotal.toFixed(2) : "\u2014"}
            </TableCell>
            <TableCell className="text-right font-medium">
              100.0%
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  )
}

// --- Main Component ---

export function CostAllocationTable() {
  const { data: session } = useSession()
  const [month, setMonth] = React.useState(getCurrentMonth)
  const [monthEnd, setMonthEnd] = React.useState<string | undefined>(undefined)
  const [rangeMode, setRangeMode] = React.useState(false)
  const [teamId, setTeamId] = React.useState<number | undefined>(undefined)

  // Team cost form state (persisted to DB)
  const [totalCost, setTotalCost] = React.useState<number | undefined>(
    undefined
  )
  const [headcount, setHeadcount] = React.useState<number | undefined>(
    undefined
  )
  const [currency, setCurrency] = React.useState("CZK")
  const [costSaving, setCostSaving] = React.useState(false)
  const [costDirty, setCostDirty] = React.useState(false)

  // Multi-month cost map
  const [monthCosts, setMonthCosts] = React.useState<Map<string, TeamCostData>>(
    new Map()
  )

  const [projectData, setProjectData] =
    React.useState<ProjectAllocationResult | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [teams, setTeams] = React.useState<Team[]>([])

  // Load teams from session organizations
  React.useEffect(() => {
    if (!session?.organizations) return
    const orgTeams: Team[] = []
    async function fetchTeams() {
      if (!session?.organizations) return
      for (const org of session.organizations) {
        try {
          const res = await fetch(`/api/organizations/${org.id}/teams`)
          if (res.ok) {
            const data = await res.json()
            for (const team of data) {
              if (
                team.id !== undefined &&
                team.name !== undefined &&
                !orgTeams.some((t) => t.id === team.id)
              ) {
                orgTeams.push({ id: team.id, name: team.name })
              }
            }
          }
        } catch {
          // Silently ignore team loading errors
        }
      }
      setTeams(orgTeams)
    }
    fetchTeams()
  }, [session?.organizations])

  // Effective end month for API calls
  const effectiveMonthEnd = rangeMode ? monthEnd : undefined

  // Load saved team costs when month, monthEnd, rangeMode, or teamId changes
  React.useEffect(() => {
    if (teamId === undefined) {
      setMonthCosts(new Map())
      setTotalCost(undefined)
      setHeadcount(undefined)
      setCurrency("CZK")
      setCostDirty(false)
      return
    }

    let cancelled = false

    async function loadCosts() {
      const newCosts = new Map<string, TeamCostData>()

      if (rangeMode && monthEnd) {
        // Range mode: fetch costs for all months
        const months = expandMonths(month, monthEnd)
        const results = await Promise.allSettled(
          months.map(async (m) => {
            const res = await fetch(`/api/teams/${teamId}/costs?month=${m}`)
            if (res.ok) {
              const data: TeamCostData | null = await res.json()
              return { month: m, data }
            }
            return { month: m, data: null }
          })
        )
        for (const result of results) {
          if (result.status === "fulfilled" && result.value.data) {
            newCosts.set(result.value.month, result.value.data)
          }
        }
      } else {
        // Single month mode: fetch cost for the selected month
        try {
          const res = await fetch(`/api/teams/${teamId}/costs?month=${month}`)
          if (res.ok) {
            const data: TeamCostData | null = await res.json()
            if (data) {
              newCosts.set(month, data)
              if (!cancelled) {
                setTotalCost(data.totalCost)
                setHeadcount(data.headcount)
                setCurrency(data.currency)
              }
            } else {
              if (!cancelled) {
                setTotalCost(undefined)
                setHeadcount(undefined)
                setCurrency("CZK")
              }
            }
            if (!cancelled) {
              setCostDirty(false)
            }
          }
        } catch {
          // Keep current values on error
        }
      }

      if (!cancelled) {
        setMonthCosts(newCosts)
      }
    }

    loadCosts()
    return () => {
      cancelled = true
    }
  }, [month, monthEnd, rangeMode, teamId])

  // Fetch cost allocation data
  React.useEffect(() => {
    let cancelled = false
    async function fetchData() {
      setLoading(true)
      try {
        const params = new URLSearchParams({ month })
        if (effectiveMonthEnd) {
          params.set("monthEnd", effectiveMonthEnd)
        }
        if (teamId !== undefined) {
          params.set("teamId", String(teamId))
        }
        const res = await fetch(
          `/api/analytics/cost-allocation?${params.toString()}`
        )
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        if (!cancelled) {
          const result: ProjectAllocationResult = await res.json()
          setProjectData(result)
        }
      } catch (error) {
        console.error("Failed to fetch cost allocation data:", error)
        if (!cancelled) {
          setProjectData(null)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }
    fetchData()
    return () => {
      cancelled = true
    }
  }, [month, effectiveMonthEnd, teamId])

  const handleSaveCost = async () => {
    if (
      teamId === undefined ||
      totalCost === undefined ||
      headcount === undefined
    )
      return

    setCostSaving(true)
    try {
      const res = await fetch(`/api/teams/${teamId}/costs`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month,
          totalCost,
          headcount,
          currency,
        }),
      })
      if (res.ok) {
        setCostDirty(false)
        // Update the monthCosts map with the saved value
        setMonthCosts((prev) => {
          const next = new Map(prev)
          next.set(month, { teamId, month, totalCost, headcount, currency })
          return next
        })
      }
    } catch (error) {
      console.error("Failed to save team cost:", error)
    } finally {
      setCostSaving(false)
    }
  }

  const handleExportCsv = () => {
    if (!projectData) return

    const csv = buildProjectCsvContent(projectData, monthCosts)
    const teamName = projectData.team?.name
    const monthSuffix = effectiveMonthEnd
      ? `${projectData.month}-to-${effectiveMonthEnd}`
      : projectData.month
    const filename = `cost-allocation-project-${monthSuffix}${teamName ? `-${teamName}` : ""}.csv`
    downloadCsv(filename, csv)
  }

  const hasData = projectData && projectData.allocations.length > 0
  const isMultiMonth = projectData?.monthlyBreakdowns && projectData.monthlyBreakdowns.length > 0

  // Compute effective team cost for single-month table
  const effectiveTeamCost = (() => {
    if (!projectData) return undefined
    const cost = monthCosts.get(projectData.month)
    return cost?.totalCost !== undefined && cost.totalCost > 0
      ? cost.totalCost
      : undefined
  })()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost Allocation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Controls row */}
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label>Period</Label>
            <ToggleGroup
              type="single"
              value={rangeMode ? "range" : "single"}
              onValueChange={(val) => {
                if (val === "range") {
                  setRangeMode(true)
                  if (!monthEnd) setMonthEnd(month)
                } else if (val === "single") {
                  setRangeMode(false)
                }
              }}
              variant="outline"
              size="sm"
            >
              <ToggleGroupItem value="single">Month</ToggleGroupItem>
              <ToggleGroupItem value="range">Range</ToggleGroupItem>
            </ToggleGroup>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cost-month">{rangeMode ? "From" : "Month"}</Label>
            <Input
              id="cost-month"
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="w-40"
            />
          </div>

          {rangeMode && (
            <div className="space-y-1.5">
              <Label htmlFor="cost-month-end">To</Label>
              <Input
                id="cost-month-end"
                type="month"
                value={monthEnd ?? month}
                min={month}
                onChange={(e) => setMonthEnd(e.target.value)}
                className="w-40"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="cost-team">Team</Label>
            <Select
              value={teamId !== undefined ? String(teamId) : "all"}
              onValueChange={(val) =>
                setTeamId(val === "all" ? undefined : parseInt(val, 10))
              }
            >
              <SelectTrigger id="cost-team" className="w-48">
                <SelectValue placeholder="All Teams" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Teams</SelectItem>
                {teams.map((team) => (
                  <SelectItem key={team.id} value={String(team.id)}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={!hasData}
          >
            <IconDownload className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>

        {/* Team cost form — only shown when a team is selected AND single-month mode */}
        {teamId !== undefined && !rangeMode && (
          <div className="flex flex-wrap items-end gap-4 rounded-md border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="cost-total">Total Cost</Label>
              <Input
                id="cost-total"
                type="number"
                min={0}
                step={0.01}
                placeholder="Monthly total..."
                value={totalCost ?? ""}
                onChange={(e) => {
                  const val = e.target.value
                  setTotalCost(val === "" ? undefined : parseFloat(val))
                  setCostDirty(true)
                }}
                className="w-40"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cost-headcount">Headcount</Label>
              <Input
                id="cost-headcount"
                type="number"
                min={1}
                step={1}
                placeholder="Team size..."
                value={headcount ?? ""}
                onChange={(e) => {
                  const val = e.target.value
                  setHeadcount(val === "" ? undefined : parseInt(val, 10))
                  setCostDirty(true)
                }}
                className="w-28"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cost-currency">Currency</Label>
              <Select
                value={currency}
                onValueChange={(val) => {
                  setCurrency(val)
                  setCostDirty(true)
                }}
              >
                <SelectTrigger id="cost-currency" className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CZK">CZK</SelectItem>
                  <SelectItem value="USD">USD</SelectItem>
                  <SelectItem value="EUR">EUR</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="default"
              size="sm"
              onClick={handleSaveCost}
              disabled={
                !costDirty ||
                costSaving ||
                totalCost === undefined ||
                headcount === undefined
              }
            >
              <IconDeviceFloppy className="mr-2 h-4 w-4" />
              {costSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        )}

        {/* Table */}
        {loading ? (
          <LoadingSkeleton />
        ) : !hasData ? (
          <div className="text-muted-foreground py-8 text-center text-sm">
            No commit data found for {effectiveMonthEnd ? `${month} \u2013 ${effectiveMonthEnd}` : month}.
          </div>
        ) : isMultiMonth ? (
          <MultiMonthProjectTable data={projectData} monthCosts={monthCosts} />
        ) : (
          <SingleMonthProjectTable data={projectData} teamCost={effectiveTeamCost} />
        )}
      </CardContent>
    </Card>
  )
}
