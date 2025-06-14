import { GlossaryClient } from "./client";

export const metadata = {
  title: "Glossary | Unkey",
  description: "Learn about all the important parts of API and API development.",
  openGraph: {
    title: "Glossary | Unkey",
    description: "Learn about all the important parts of API and API development.",
    url: "https://unkey.com/glossary",
    siteName: "unkey.com",
    images: [
      {
        url: "https://unkey.com/images/landing/og.png",
        width: 1200,
        height: 675,
      },
    ],
  },
  twitter: {
    title: "Glossary | Unkey",
    card: "summary_large_image",
  },
  icons: {
    shortcut: "/images/landing/unkey.png",
  },
};

export default function GlossaryPage() {
  return (
    <div>
      <GlossaryClient />
    </div>
  );
}
