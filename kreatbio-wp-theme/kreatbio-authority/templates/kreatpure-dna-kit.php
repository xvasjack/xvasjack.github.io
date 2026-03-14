<?php
/*
Template Name: KreatPure DNA Kit
Template Post Type: page
*/
if (!defined('ABSPATH')) {
    exit;
}
get_header();
?>
<main>
      <section class="hero">
        <div class="container hero-grid">
          <div class="reveal">
            <span class="eyebrow">DNA Workflow Product</span>
            <h1>KreatPure DNA Extraction Kit</h1>
            <p class="lead">A clean, repeatable DNA extraction workflow built for day-to-day lab use.</p>
            <div class="hero-actions">
              <a class="btn btn-primary" href="<?php echo esc_url(kreatbio_authority_page_url('contact')); ?>">Request Pricing</a>
              <a class="btn btn-secondary" href="<?php echo esc_url(kreatbio_authority_page_url('resources')); ?>">Download Protocol</a>
            </div>
          </div>
          <aside class="hero-panel reveal">
            <h3>What you get</h3>
            <ul class="hero-panel-list">
              <li><span class="hero-panel-dot"></span><span>Clear protocol flow and timing guidance.</span></li>
              <li><span class="hero-panel-dot"></span><span>Workflow notes for repeatable extraction outcomes.</span></li>
              <li><span class="hero-panel-dot"></span><span>Troubleshooting support for common lab scenarios.</span></li>
              <li><span class="hero-panel-dot"></span><span>Document package for onboarding and internal training.</span></li>
            </ul>
          </aside>
        </div>
      </section>

      <section class="section">
        <div class="container grid grid-2">
          <article class="card reveal">
            <h2>Built for</h2>
            <ul class="ticks">
              <li><span class="tick-icon">+</span><span>Academic and research labs.</span></li>
              <li><span class="tick-icon">+</span><span>Biotech startups scaling R&amp;D basics.</span></li>
              <li><span class="tick-icon">+</span><span>Teaching labs that need dependable workflows.</span></li>
            </ul>
          </article>

          <article class="card reveal">
            <h2>Workflow overview</h2>
            <ol class="steps">
              <li><div><h3>Lysis</h3><p>Break open cells and release nucleic material.</p></div></li>
              <li><div><h3>Bind and wash</h3><p>Capture target DNA and remove unwanted residues.</p></div></li>
              <li><div><h3>Elute</h3><p>Collect purified DNA for downstream analysis or teaching workflows.</p></div></li>
            </ol>
          </article>
        </div>
      </section>

      <section class="section">
        <div class="container reveal">
          <div class="section-title-wrap">
            <p class="section-kicker">Documentation</p>
            <h2>Suggested document stack</h2>
            <p class="lead">Use this list to present authority and readiness without overclaiming.</p>
          </div>
          <div class="grid grid-2">
            <article class="card">
              <ul class="ticks">
                <li><span class="tick-icon">+</span><span>Technical data sheet</span></li>
                <li><span class="tick-icon">+</span><span>Full protocol PDF</span></li>
                <li><span class="tick-icon">+</span><span>Quick start guide</span></li>
              </ul>
            </article>
            <article class="card">
              <ul class="ticks">
                <li><span class="tick-icon">+</span><span>Safety data sheet (SDS)</span></li>
                <li><span class="tick-icon">+</span><span>Certificate of analysis (if available)</span></li>
                <li><span class="tick-icon">+</span><span>Troubleshooting note</span></li>
              </ul>
            </article>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="notice reveal">Only include performance numbers if they are backed by your current internal data package.</div>
          <div class="cta-band reveal">
            <div>
              <h3>Need help choosing kit format?</h3>
              <p>Share your sample type and team setup to get a guided recommendation.</p>
            </div>
            <a class="btn btn-primary" href="<?php echo esc_url(kreatbio_authority_page_url('contact')); ?>">Talk to a Specialist</a>
          </div>
        </div>
      </section>
    </main>
<?php get_footer(); ?>
