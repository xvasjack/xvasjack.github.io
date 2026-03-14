<?php
/*
Template Name: Home
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
            <span class="eyebrow">Biotech Startup Ready</span>
            <h1>Confident DNA extraction. Practical bioinformatics learning.</h1>
            <p class="lead">
              KreatBio delivers two focused products for modern labs and classrooms: the
              <strong>KreatPure DNA Extraction Kit</strong> and the
              <strong>KodaGeno Bioinformatics Learning Platform</strong>.
            </p>
            <div class="hero-actions">
              <a class="btn btn-primary" href="<?php echo esc_url(kreatbio_authority_page_url('contact')); ?>">Request a Quote</a>
              <a class="btn btn-secondary" href="<?php echo esc_url(kreatbio_authority_page_url('contact')); ?>">Book KodaGeno Demo</a>
            </div>
          </div>

          <aside class="hero-panel reveal">
            <h3>Credibility by design</h3>
            <ul class="hero-panel-list">
              <li>
                <span class="hero-panel-dot"></span>
                <span>Documentation-first product pages with clear setup guidance.</span>
              </li>
              <li>
                <span class="hero-panel-dot"></span>
                <span>Clean workflow structure: sample prep, extraction, and analysis handoff.</span>
              </li>
              <li>
                <span class="hero-panel-dot"></span>
                <span>Staging-first publishing model so your live website stays safe.</span>
              </li>
              <li>
                <span class="hero-panel-dot"></span>
                <span>Support-oriented messaging for labs and instructors.</span>
              </li>
            </ul>
          </aside>
        </div>
      </section>

      <section class="section section-tight">
        <div class="container">
          <div class="section-title-wrap reveal">
            <p class="section-kicker">Product Portfolio</p>
            <h2>Two products. One clear mission.</h2>
            <p class="lead">Reliable lab execution and practical bioinformatics capability building.</p>
          </div>

          <div class="grid grid-2">
            <article class="card kit-card reveal">
              <h3>KreatPure DNA Extraction Kit</h3>
              <p>
                Get clean, usable DNA with a simple workflow your team can run repeatedly with confidence.
              </p>
              <ul class="ticks">
                <li><span class="tick-icon">+</span><span>Step-by-step protocol language for daily use.</span></li>
                <li><span class="tick-icon">+</span><span>Troubleshooting guidance for common extraction issues.</span></li>
                <li><span class="tick-icon">+</span><span>Fits startup and academic lab operations.</span></li>
              </ul>
              <p style="margin-top: 1rem"><a class="btn btn-secondary" href="<?php echo esc_url(kreatbio_authority_page_url('kreatpure-dna-kit')); ?>">View Kit Details</a></p>
            </article>

            <article class="card platform-card reveal">
              <h3>KodaGeno Bioinformatics Learning Platform</h3>
              <p>
                Teach bioinformatics with guided lessons, ready datasets, and instructor tools that reduce prep time.
              </p>
              <ul class="ticks">
                <li><span class="tick-icon">+</span><span>Lesson-ready modules for fast classroom launch.</span></li>
                <li><span class="tick-icon">+</span><span>Hands-on analysis workflows for real learning outcomes.</span></li>
                <li><span class="tick-icon">+</span><span>Progress visibility for instructors and program leads.</span></li>
              </ul>
              <p style="margin-top: 1rem"><a class="btn btn-secondary" href="<?php echo esc_url(kreatbio_authority_page_url('kodageno-learning-platform')); ?>">View Platform Details</a></p>
            </article>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="section-title-wrap reveal">
            <p class="section-kicker">Trust Signals</p>
            <h2>Why teams trust KreatBio</h2>
          </div>

          <div class="metric-row reveal">
            <div class="metric">
              <span class="metric-value">2</span>
              <span class="metric-label">Focused flagship product lines</span>
            </div>
            <div class="metric">
              <span class="metric-value">Docs</span>
              <span class="metric-label">Protocol-first release discipline</span>
            </div>
            <div class="metric">
              <span class="metric-value">Staging</span>
              <span class="metric-label">Safe testing before live publish</span>
            </div>
          </div>

          <div class="grid grid-3" style="margin-top: 1rem">
            <article class="card reveal">
              <h3>Evidence-first product language</h3>
              <p>
                Product claims stay grounded in what can be shown through documents, guides, and practical usage detail.
              </p>
            </article>
            <article class="card reveal">
              <h3>Support from real people</h3>
              <p>
                Teams get help for setup, troubleshooting, and rollout planning across lab and classroom environments.
              </p>
            </article>
            <article class="card reveal">
              <h3>Workflow clarity</h3>
              <p>
                Visitors can understand quickly how sample prep, extraction, and analysis teaching connect end to end.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container grid grid-2">
          <div class="reveal">
            <div class="section-title-wrap">
              <p class="section-kicker">Workflow Logic</p>
              <h2>From sample to insight in three steps</h2>
            </div>
            <ol class="steps">
              <li>
                <div>
                  <h3>Prepare</h3>
                  <p>Use clear sample preparation guidance before extraction starts.</p>
                </div>
              </li>
              <li>
                <div>
                  <h3>Extract</h3>
                  <p>Run the KreatPure workflow to isolate DNA for downstream use.</p>
                </div>
              </li>
              <li>
                <div>
                  <h3>Learn and analyze</h3>
                  <p>Use KodaGeno to train teams on bioinformatics interpretation workflows.</p>
                </div>
              </li>
            </ol>
          </div>

          <div class="reveal">
            <div class="section-title-wrap">
              <p class="section-kicker">Ideal Users</p>
              <h2>Who we serve</h2>
            </div>
            <ul class="ticks">
              <li>
                <span class="tick-icon">+</span>
                <span>Biotech startups building internal R&amp;D capability.</span>
              </li>
              <li>
                <span class="tick-icon">+</span>
                <span>University and college teaching labs.</span>
              </li>
              <li>
                <span class="tick-icon">+</span>
                <span>Research teams that need practical and repeatable workflows.</span>
              </li>
            </ul>

            <div class="callout" style="margin-top: 1rem">
              <strong>Important:</strong> publish only claims you can prove with current technical documents or internal evidence.
            </div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="cta-band reveal">
            <div>
              <h3>Ready to modernize your lab and classroom workflow?</h3>
              <p>Start with one product or deploy both together.</p>
            </div>
            <div class="hero-actions" style="margin-top: 0">
              <a class="btn btn-primary" href="<?php echo esc_url(kreatbio_authority_page_url('contact')); ?>">Talk to Sales</a>
              <a class="btn btn-ghost" href="<?php echo esc_url(kreatbio_authority_page_url('resources')); ?>">See Resources</a>
            </div>
          </div>
        </div>
      </section>
    </main>
<?php get_footer(); ?>
