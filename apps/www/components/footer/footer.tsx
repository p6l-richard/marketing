"use client";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { UnkeyLogo } from "./footer-svgs";
import { Wordmark } from "./wordmark";

type NavLink = {
  title: string;
  href: string;
  external?: boolean;
};
const navigation = [
  {
    title: "Company",
    links: [
      { title: "About", href: "/about" },

      { title: "Roadmap", href: "/roadmap" },
      { title: "Careers", href: "/careers" },
      {
        title: "Source Code",
        href: "https://go.unkey.com/github",
        external: true,
      },
      {
        title: "Status Page",
        href: "https://status.unkey.com",
        external: true,
      },
    ],
  },
  {
    title: "Resources",
    links: [
      { title: "Blog", href: "/blog" },
      { title: "Changelog", href: "/changelog" },
      { title: "Templates", href: "/templates" },
      {
        title: "Docs",
        href: "/docs",
        external: true,
      },
      {
        title: "Glossary",
        href: "/glossary",
      },
    ],
  },
  {
    title: "Connect",
    links: [
      {
        title: "X (Twitter)",
        href: "https://go.unkey.com/twitter",
        external: true,
      },
      {
        title: "Discord",
        href: "https://go.unkey.com/discord",
        external: true,
      },
      { title: "OSS Friends", href: "/oss-friends" },
      {
        title: "Book a Call",
        href: "https://cal.com/team/unkey/user-interview?utm_source=banner&utm_campaign=oss",
        external: true,
      },
    ],
  },
  {
    title: "Legal",
    links: [
      { title: "Terms of Service", href: "/policies/terms" },
      { title: "Privacy Policy", href: "/policies/privacy" },
    ],
  },
] satisfies Array<{ title: string; links: Array<NavLink> }>;

const Column: React.FC<{
  title: string;
  links: Array<NavLink>;
  className?: string;
}> = ({ title, links, className }) => {
  return (
    <div className={cn("flex flex-col gap-8   text-left ", className)}>
      <span className="w-full text-sm font-medium tracking-wider text-white font-display">
        {title}
      </span>
      <ul className="flex flex-col gap-4 md:gap-6">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              target={link.external ? "_blank" : undefined}
              rel={link.external ? "noopener noreferrer" : undefined}
              className="text-sm font-normal transition hover:text-white/40 text-white/70"
            >
              {link.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
};

export function Footer() {
  return (
    <div className="border-t border-white/20 blog-footer-radial-gradient">
      <footer className="container relative grid grid-cols-2 gap-8 pt-8 mx-auto overflow-hidden lg:gap-16 sm:grid-cols-3 xl:grid-cols-5 sm:pt-12 md:pt-16 lg:pt-24 xl:pt-32">
        <div className="flex flex-col items-center col-span-2 sm:items-start sm:col-span-3 xl:col-span-1">
          <UnkeyLogo />
          <div className="mt-8 text-sm font-normal leading-6 text-white/60">
            Build better APIs faster.
          </div>
          <div className="text-sm font-normal leading-6 text-white/40">
            Unkeyed, Inc. {new Date().getUTCFullYear()}
          </div>
        </div>

        {navigation.map(({ title, links }) => (
          <Column key={title} title={title} links={links} className="col-span-1 " />
        ))}
      </footer>
      <div className="container mt-8 h-[100px]">
        <Wordmark className="flex w-full" />
      </div>
    </div>
  );
}
