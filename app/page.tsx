import { HeroVideo } from "@/components/HeroVideo";
import { SearchBox } from "@/components/SearchBox";
import { Shortcuts } from "@/components/Shortcuts";
import { SiteHeader } from "@/components/SiteHeader";

const hints = ["How far away is Mars?", "Olympus Mons", "Best hiking trails near me", "How do rockets work?"];

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="panel panel-1">
          <HeroVideo />
          <div className="panel-shade" />
          <div className="panel-content hero-content">
            <p className="eyebrow rise" style={{ animationDelay: "0.1s" }}>Search, simplified</p>
            <h1 className="rise" style={{ animationDelay: "0.2s" }}>Find anything on Mars</h1>
            <div className="hero-search rise" style={{ animationDelay: "0.35s" }}>
              <SearchBox autoFocus large placeholders={hints} />
            </div>
            <div className="rise" style={{ animationDelay: "0.5s" }}>
              <Shortcuts />
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
