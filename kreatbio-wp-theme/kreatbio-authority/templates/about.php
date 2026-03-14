<?php
/*
Template Name: About
Template Post Type: page
*/
if (!defined('ABSPATH')) {
    exit;
}
get_header();
?>
<main>
      <section class="hero">
        <div class="container">
          <div class="section-title-wrap reveal">
            <p class="section-kicker">About KreatBio</p>
            <h1>Built to make biotech workflows more usable and teachable</h1>
            <p class="lead">
              KreatBio builds practical products for research teams and educators. We focus on clear workflows, evidence-led product language, and support that helps teams succeed quickly.
            </p>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container grid grid-3">
          <article class="card reveal">
            <h3>Our focus</h3>
            <p>Make DNA extraction simple, repeatable, and easier to operationalize in daily lab work.</p>
          </article>
          <article class="card reveal">
            <h3>Our learning mission</h3>
            <p>Make bioinformatics training practical through guided, hands-on exercises in KodaGeno.</p>
          </article>
          <article class="card reveal">
            <h3>Our discipline</h3>
            <p>Prioritize documentation clarity and support responsiveness over inflated marketing claims.</p>
          </article>
        </div>
      </section>

      <section class="section">
        <div class="container grid grid-2">
          <article class="card reveal">
            <h2>How we build authority</h2>
            <ul class="ticks">
              <li><span class="tick-icon">+</span><span>Clear product architecture and page hierarchy.</span></li>
              <li><span class="tick-icon">+</span><span>Documents and guides available where users need them.</span></li>
              <li><span class="tick-icon">+</span><span>Workflow-based messaging that supports real lab and teaching use.</span></li>
            </ul>
          </article>
          <article class="card reveal">
            <h2>How we work with customers</h2>
            <ul class="ticks">
              <li><span class="tick-icon">+</span><span>Understand your current process first.</span></li>
              <li><span class="tick-icon">+</span><span>Match the right product setup to your goals.</span></li>
              <li><span class="tick-icon">+</span><span>Support rollout and early troubleshooting.</span></li>
            </ul>
          </article>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="cta-band reveal">
            <div>
              <h3>Want a walkthrough of both products?</h3>
              <p>We can map a starter setup for your lab and training needs.</p>
            </div>
            <a class="btn btn-primary" href="<?php echo esc_url(kreatbio_authority_page_url('contact')); ?>">Book a Call</a>
          </div>
        </div>
      </section>
    </main>
<?php get_footer(); ?>
