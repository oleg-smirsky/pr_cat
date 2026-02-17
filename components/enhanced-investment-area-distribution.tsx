"use client";

import { useEffect, useMemo, useState } from "react";
import { useTeamFilterParams, useTeamFilter } from "@/hooks/use-team-filter";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { 
  ChartConfig, 
  ChartContainer, 
  ChartLegend,
  ChartLegendContent,
  ChartTooltip, 
  ChartTooltipContent 
} from "@/components/ui/chart";

type TimeSeriesDataPoint = {
  date: string;
  [key: string]: string | number;
};

type CategoryInfo = {
  key: string;
  label: string;
  color: string;
};

type TimeSeriesResponse = {
  data: TimeSeriesDataPoint[];
  categories: CategoryInfo[];
};

interface EnhancedInvestmentAreaDistributionProps {
  initialData?: TimeSeriesResponse;
  className?: string;
}

export function EnhancedInvestmentAreaDistribution({
  initialData,
  className
}: EnhancedInvestmentAreaDistributionProps) {
  const teamFilterParams = useTeamFilterParams();
  const { timeRange } = useTeamFilter();
  const [data, setData] = useState<TimeSeriesDataPoint[]>(initialData?.data || []);
  const [categories, setCategories] = useState<CategoryInfo[]>(initialData?.categories || []);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState<string | null>(null);
  const teamFilterQuery = useMemo(() => new URLSearchParams(teamFilterParams).toString(), [teamFilterParams]);
  const requestQuery = useMemo(() => {
    const params = new URLSearchParams(teamFilterQuery);
    params.set('timeRange', timeRange);
    params.set('format', 'timeseries');
    return params.toString();
  }, [teamFilterQuery, timeRange]);

  // Initialize selected categories when we have initial data or data changes
  useEffect(() => {
    if (categories.length > 0 && selectedCategories.length === 0) {
      setSelectedCategories(categories.map(cat => cat.key));
    }
  }, [categories, selectedCategories.length]);

  // Background refresh after initial load
  useEffect(() => {
    if (!initialData) return;
    
    // Delay background refresh by 3 seconds to not interfere with initial render
    const refreshTimer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/pull-requests/category-distribution?${requestQuery}`);
        if (response.ok) {
          const timeSeriesData: TimeSeriesResponse = await response.json();
          setData(timeSeriesData.data);
          setCategories(timeSeriesData.categories);
        }
      } catch (error) {
        // Silent fail on background refresh - we have initial data
        console.warn("Background refresh failed:", error);
      }
    }, 3000);
    
    return () => clearTimeout(refreshTimer);
  }, [initialData, requestQuery]);

  useEffect(() => {
    if (initialData) return; // Skip if we have initial data
    
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await fetch(`/api/pull-requests/category-distribution?${requestQuery}`);
        
        if (!response.ok) {
          throw new Error(`Failed to fetch category distribution: ${response.status} ${response.statusText}`);
        }
        
        const timeSeriesData: TimeSeriesResponse = await response.json();
        
        setData(timeSeriesData.data);
        setCategories(timeSeriesData.categories);
        
        // Auto-select all categories for bar chart
        setSelectedCategories(timeSeriesData.categories.map(cat => cat.key));
        
      } catch (error) {
        console.error("Failed to load category distribution:", error);
        setError(error instanceof Error ? error.message : "An unknown error occurred");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [initialData, requestQuery]);

  const filteredData = data.filter(item => {
    const date = new Date(item.date);
    const today = new Date();
    let daysToSubtract = 30;
    
    if (timeRange === "7d") {
      daysToSubtract = 7;
    } else if (timeRange === "90d") {
      daysToSubtract = 90;
    }
    
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - daysToSubtract);
    
    return date >= startDate;
  });

  const getStandardizedColor = (categoryKey: string, categoryLabel: string) => {
    // Standardize colors to match PR activity table
    const lowerKey = categoryKey.toLowerCase();
    const lowerLabel = categoryLabel.toLowerCase();
    
    if (lowerKey.includes('bug') || lowerLabel.includes('bug') || lowerLabel.includes('fix')) {
      return '#ef4444'; // red-500
    }
    if (lowerKey.includes('feature') || lowerLabel.includes('feature') || lowerLabel.includes('enhancement')) {
      return '#3b82f6'; // blue-500
    }
    if (lowerKey.includes('debt') || lowerLabel.includes('debt') || lowerLabel.includes('refactor')) {
      return '#eab308'; // yellow-500
    }
    if (lowerKey.includes('doc') || lowerLabel.includes('doc')) {
      return '#10b981'; // green-500
    }
    if (lowerKey.includes('ui') || lowerLabel.includes('ux') || lowerLabel.includes('product')) {
      return '#8b5cf6'; // violet-500
    }
    
    // Default fallback color
    return '#6b7280'; // gray-500
  };

  const chartConfig: ChartConfig = categories.reduce((config, category) => {
    config[category.key] = {
      label: category.label,
      color: getStandardizedColor(category.key, category.label),
    };
    return config;
  }, {} as ChartConfig);

  const handleCategoryToggle = (categoryKey: string) => {
    if (selectedCategories.includes(categoryKey)) {
      // Remove the category if it's already selected
      if (selectedCategories.length > 1) { // Ensure at least one category is always selected
        setSelectedCategories(selectedCategories.filter(c => c !== categoryKey));
      }
    } else {
      // Add the category
      setSelectedCategories([...selectedCategories, categoryKey]);
    }
  };

  const getTimeRangeLabel = () => {
    switch (timeRange) {
      case '7d': return 'Last 7 days';
      case '30d': return 'Last 30 days';
      case '90d': return 'Last 90 days';
      default: return 'Last 30 days';
    }
  };

  if (loading) {
    return (
      <Card className={`@container/card ${className || ''}`}>
        <CardHeader>
          <CardTitle>Team Focus Distribution</CardTitle>
          <CardDescription>Loading team focus trends...</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[300px] w-full animate-pulse bg-muted"></div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className={`@container/card ${className || ''}`}>
        <CardHeader>
          <CardTitle>Team Focus Distribution</CardTitle>
          <CardDescription className="text-red-500">Error loading data</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-red-500">{error}</p>
          <button 
            onClick={() => window.location.reload()} 
            className="mt-4 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Retry
          </button>
        </CardContent>
      </Card>
    );
  }

  if (data.length === 0 || categories.length === 0) {
    return (
      <Card className={`@container/card ${className || ''}`}>
        <CardHeader>
          <CardTitle>Team Focus Distribution</CardTitle>
          <CardDescription>No category data available</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            No PR categories found. Categories will appear here once PRs are categorized.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={`@container/card ${className || ''}`}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          Focus Distribution
          {initialData && (
            <span className="text-xs text-muted-foreground font-normal">
              ⚡ Server-enhanced
            </span>
          )}
        </CardTitle>
        <CardDescription>
          <span className="@[540px]/card:hidden">Daily focus breakdown • {getTimeRangeLabel()}</span>
          <span className="hidden @[540px]/card:block">
            Daily breakdown of your teams collaborative energy across categories • {getTimeRangeLabel()}
          </span>
        </CardDescription>
      </CardHeader>
      
      {/* Filters Row */}
      <div className="flex items-center justify-between gap-4 px-6 pb-4">
        <div className="hidden lg:flex gap-2">
          {categories.map((category) => (
            <button 
              key={category.key}
              onClick={() => handleCategoryToggle(category.key)}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                selectedCategories.includes(category.key) 
                ? 'bg-primary/10 text-primary' 
                : 'bg-transparent text-muted-foreground hover:bg-muted'
              }`}
            >
              {category.label}
            </button>
          ))}
        </div>

      </div>
      
      <CardContent>
        <ChartContainer config={chartConfig} className="aspect-auto h-[300px] w-full">
          <BarChart accessibilityLayer data={filteredData}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              tickMargin={10}
              axisLine={false}
              tickFormatter={(value) => {
                const date = new Date(value);
                return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
              }}
            />
            <ChartTooltip content={<ChartTooltipContent variant="labelless" />} />
            <ChartLegend content={<ChartLegendContent />} />
            
            {selectedCategories.map((categoryKey, index) => {
              const category = categories.find(c => c.key === categoryKey);
              if (!category) return null;
              
              const isFirst = index === 0;
              const isLast = index === selectedCategories.length - 1;
              
              return (
                <Bar
                  key={categoryKey}
                  dataKey={categoryKey}
                  stackId="a"
                  fill={`var(--color-${categoryKey})`}
                  radius={
                    selectedCategories.length === 1 
                      ? [4, 4, 4, 4] // Single bar gets rounded on all corners
                      : isLast 
                        ? [4, 4, 0, 0] // Top bar gets rounded top corners
                        : isFirst 
                          ? [0, 0, 4, 4] // Bottom bar gets rounded bottom corners  
                          : [0, 0, 0, 0] // Middle bars have no radius
                  }
                />
              );
            })}
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
