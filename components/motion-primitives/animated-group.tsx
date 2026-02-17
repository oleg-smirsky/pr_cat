"use client"

import React from "react"
import { motion, Variants } from "framer-motion"
import { cn } from "@/lib/utils"

const motionElements = {
  article: motion.article,
  div: motion.div,
  footer: motion.footer,
  header: motion.header,
  li: motion.li,
  main: motion.main,
  nav: motion.nav,
  ol: motion.ol,
  p: motion.p,
  section: motion.section,
  span: motion.span,
  ul: motion.ul,
} as const

type MotionElementTag = keyof typeof motionElements

interface AnimatedGroupProps {
  children: React.ReactNode
  variants?: Variants
  className?: string
  as?: MotionElementTag
  delay?: number
}

export function AnimatedGroup({
  children,
  variants,
  className,
  as: Component = "div",
  delay = 0,
}: AnimatedGroupProps) {
  const MotionComponent = motionElements[Component] || motion.div

  const defaultVariants = {
    hidden: {
      opacity: 0,
    },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
        delayChildren: delay,
      },
    },
  }

  const finalVariants = variants || defaultVariants

  return (
    <MotionComponent
      className={cn(className)}
      variants={finalVariants}
      initial="hidden"
      animate="visible"
    >
      {children}
    </MotionComponent>
  )
}
