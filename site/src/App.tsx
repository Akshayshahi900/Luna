// The Luna product site: one page, sections in reading order.
import { Capabilities } from "./sections/Capabilities";
import { Faq, Footer } from "./sections/Faq";
import { Hero } from "./sections/Hero";
import { How } from "./sections/How";
import { Install } from "./sections/Install";
import { Nav } from "./sections/Nav";
import { Showcase } from "./sections/Showcase";
import { Specs } from "./sections/Specs";
import { Usage } from "./sections/Usage";

export default function App() {
  return (
    <>
      <a className="skip" href="#capabilities">
        Skip to content
      </a>
      <Nav />
      <main>
        <Hero />
        <Capabilities />
        <Showcase />
        <How />
        <Specs />
        <Install />
        <Usage />
        <Faq />
      </main>
      <Footer />
    </>
  );
}
