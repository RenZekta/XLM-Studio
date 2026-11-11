import React from 'react'
import {
  Box, Cpu, Zap, Database, Sliders, Wind, Server, FileText, GitBranch, Star, Repeat, Image as ImageIcon, Wrench,
  Layers, Gauge, Settings, Terminal, Hash, Tag, Flame, Heart, Bookmark, Brain, Rocket, Shield, Sparkles, Cog,
  Monitor, HardDrive, Network, Bug, Code, Globe, Lock, Clock, Package, Puzzle, Eye
} from 'lucide-react'

// The icons a group header can take. Names are what a saved layout stores.
const ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  Box, Cpu, Zap, Database, Sliders, Wind, Server, FileText, GitBranch, Star, Repeat, Image: ImageIcon, Wrench,
  Layers, Gauge, Settings, Terminal, Hash, Tag, Flame, Heart, Bookmark, Brain, Rocket, Shield, Sparkles, Cog,
  Monitor, HardDrive, Network, Bug, Code, Globe, Lock, Clock, Package, Puzzle, Eye
}

export const GROUP_ICON_NAMES = Object.keys(ICONS)

export function groupIcon(name: string | undefined, size = 14): React.ReactNode {
  const Icon = name ? ICONS[name] : undefined
  return Icon ? <Icon size={size} /> : null
}
