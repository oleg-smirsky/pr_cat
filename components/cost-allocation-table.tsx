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

interface CostAllocationResult {
  month: string
  monthEnd?: string
  team: { id: number; name: string } | null
  members: Array<{
    userId: string | null
    name: string
    repos: Array<{ repositoryId: number; name: string; commits: number }>
    totalCommits: number
  }>
  repoTotals: Array<{
    repositoryId: number
    name: string
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

type GroupBy = "repository" | "project"

// --- Helpers ---

function getCurrentMonth(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  return `${year}-${month}`
}

function getRepoColumns(data: CostAllocationResult) {
  return data.repoTotals.map((r) => ({
    repositoryId: r.repositoryId,
    name: r.name,
  }))
}

function getCommitCount(
  member: CostAllocationResult["members"][number],
  repositoryId: number
): number {
  const repo = member.repos.find((r) => r.repositoryId === repositoryId)
  return repo?.commits ?? 0
}

function buildRepoCsvContent(
  data: CostAllocationResult,
  teamCost: number | undefined
): string {
  const repos = getRepoColumns(data)
  const headers = ["Developer", ...repos.map((r) => r.name), "Total"]
  const rows: string[][] = []

  for (const member of data.members) {
    const row = [
      member.name,
      ...repos.map((r) => String(getCommitCount(member, r.repositoryId))),
      String(member.totalCommits),
    ]
    rows.push(row)
  }

  // Totals row
  const totalsRow = [
    "Total",
    ...data.repoTotals.map(
      (r) => `${r.commits} (${r.percentage.toFixed(1)}%)`
    ),
    String(data.totalCommits),
  ]
  rows.push(totalsRow)

  // Cost row
  if (teamCost !== undefined && teamCost > 0) {
    const costRow = [
      "Cost",
      ...data.repoTotals.map(
        (r) => `${((r.percentage / 100) * teamCost).toFixed(2)}`
      ),
      `${teamCost.toFixed(2)}`,
    ]
    rows.push(costRow)
  }

  return formatCsv(headers, rows)
}

function buildProjectCsvContent(
  data: ProjectAllocationResult,
  teamCost: number | undefined
): string {
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

function RepositoryTable({
  data,
  teamCost,
}: {
  data: CostAllocationResult
  teamCost: number | undefined
}) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Developer</TableHead>
            {getRepoColumns(data).map((repo) => (
              <TableHead key={repo.repositoryId} className="text-right">
                {repo.name}
              </TableHead>
            ))}
            <TableHead className="text-right">Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.members.map((member) => (
            <TableRow key={member.userId ?? member.name}>
              <TableCell className="font-medium">
                {member.name}
              </TableCell>
              {getRepoColumns(data).map((repo) => (
                <TableCell
                  key={repo.repositoryId}
                  className="text-right"
                >
                  {getCommitCount(member, repo.repositoryId)}
                </TableCell>
              ))}
              <TableCell className="text-right font-medium">
                {member.totalCommits}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          {/* Totals row */}
          <TableRow>
            <TableCell className="font-medium">Total</TableCell>
            {data.repoTotals.map((repo) => (
              <TableCell
                key={repo.repositoryId}
                className="text-right"
              >
                {repo.commits}{" "}
                <span className="text-muted-foreground text-xs">
                  ({repo.percentage.toFixed(1)}%)
                </span>
              </TableCell>
            ))}
            <TableCell className="text-right font-medium">
              {data.totalCommits}
            </TableCell>
          </TableRow>

          {/* Cost allocation row */}
          {teamCost !== undefined && teamCost > 0 && (
            <TableRow>
              <TableCell className="font-medium">Cost</TableCell>
              {data.repoTotals.map((repo) => (
                <TableCell
                  key={repo.repositoryId}
                  className="text-right"
                >
                  {((repo.percentage / 100) * teamCost).toFixed(2)}
                </TableCell>
              ))}
              <TableCell className="text-right font-medium">
                {teamCost.toFixed(2)}
              </TableCell>
            </TableRow>
          )}
        </TableFooter>
      </Table>
    </div>
  )
}

function ProjectTable({
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

// --- Main Component ---

export function CostAllocationTable() {
  const { data: session } = useSession()
  const [month, setMonth] = React.useState(getCurrentMonth)
  const [monthEnd, setMonthEnd] = React.useState<string | undefined>(undefined)
  const [rangeMode, setRangeMode] = React.useState(false)
  const [teamId, setTeamId] = React.useState<number | undefined>(undefined)
  const [groupBy, setGroupBy] = React.useState<GroupBy>("repository")

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

  const [repoData, setRepoData] = React.useState<CostAllocationResult | null>(
    null
  )
  const [projectData, setProjectData] =
    React.useState<ProjectAllocationResult | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [teams, setTeams] = React.useState<Team[]>([])

  // Computed team cost for table rendering
  const effectiveTeamCost =
    totalCost !== undefined && totalCost > 0 ? totalCost : undefined

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

  // Load saved team cost when month or teamId changes
  React.useEffect(() => {
    if (teamId === undefined) {
      setTotalCost(undefined)
      setHeadcount(undefined)
      setCurrency("CZK")
      setCostDirty(false)
      return
    }

    let cancelled = false
    async function loadCost() {
      try {
        const res = await fetch(
          `/api/teams/${teamId}/costs?month=${month}`
        )
        if (!cancelled && res.ok) {
          const data: TeamCostData | null = await res.json()
          if (data) {
            setTotalCost(data.totalCost)
            setHeadcount(data.headcount)
            setCurrency(data.currency)
          } else {
            setTotalCost(undefined)
            setHeadcount(undefined)
            setCurrency("CZK")
          }
          setCostDirty(false)
        }
      } catch {
        // Keep current values on error
      }
    }
    loadCost()
    return () => {
      cancelled = true
    }
  }, [month, teamId])

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
        if (groupBy === "project") {
          params.set("groupBy", "project")
        }
        const res = await fetch(
          `/api/analytics/cost-allocation?${params.toString()}`
        )
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        if (!cancelled) {
          if (groupBy === "project") {
            const result: ProjectAllocationResult = await res.json()
            setProjectData(result)
          } else {
            const result: CostAllocationResult = await res.json()
            setRepoData(result)
          }
        }
      } catch (error) {
        console.error("Failed to fetch cost allocation data:", error)
        if (!cancelled) {
          if (groupBy === "project") {
            setProjectData(null)
          } else {
            setRepoData(null)
          }
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
  }, [month, effectiveMonthEnd, teamId, groupBy])

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
      }
    } catch (error) {
      console.error("Failed to save team cost:", error)
    } finally {
      setCostSaving(false)
    }
  }

  const handleExportCsv = () => {
    let csv: string
    let filename: string
    const teamName =
      groupBy === "project"
        ? projectData?.team?.name
        : repoData?.team?.name

    if (groupBy === "project" && projectData) {
      csv = buildProjectCsvContent(projectData, effectiveTeamCost)
      filename = `cost-allocation-project-${projectData.month}${teamName ? `-${teamName}` : ""}.csv`
    } else if (repoData) {
      csv = buildRepoCsvContent(repoData, effectiveTeamCost)
      filename = `cost-allocation-${repoData.month}${teamName ? `-${teamName}` : ""}.csv`
    } else {
      return
    }
    downloadCsv(filename, csv)
  }

  const hasData =
    groupBy === "project"
      ? projectData && projectData.allocations.length > 0
      : repoData && repoData.members.length > 0

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

          <div className="space-y-1.5">
            <Label>View</Label>
            <ToggleGroup
              type="single"
              value={groupBy}
              onValueChange={(val) => {
                if (val) setGroupBy(val as GroupBy)
              }}
              variant="outline"
              size="sm"
            >
              <ToggleGroupItem value="repository">Repository</ToggleGroupItem>
              <ToggleGroupItem value="project">Project</ToggleGroupItem>
            </ToggleGroup>
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

        {/* Team cost form — only shown when a team is selected */}
        {teamId !== undefined && (
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
            No commit data found for {effectiveMonthEnd ? `${month} – ${effectiveMonthEnd}` : month}.
          </div>
        ) : groupBy === "project" && projectData ? (
          <ProjectTable data={projectData} teamCost={effectiveTeamCost} />
        ) : repoData ? (
          <RepositoryTable data={repoData} teamCost={effectiveTeamCost} />
        ) : null}
      </CardContent>
    </Card>
  )
}
