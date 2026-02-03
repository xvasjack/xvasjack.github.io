/**
 * Local Test Script for DOCX Generation
 * Tests all section types and styling against template
 */

const fs = require('fs');
const path = require('path');
const { generateDocx } = require('./docx-generator');

// Sample DD report with all section types
const sampleReport = {
  sections: [
    // Cover page
    {
      type: 'cover_page',
      title: 'Due Diligence Report',
      companyName: 'TechCorp Industries Pte Ltd',
      date: 'January 2026',
    },

    // 1.0 Company Overview
    {
      type: 'heading1',
      text: '1.0 Company Overview',
    },
    {
      type: 'paragraph',
      text: 'TechCorp Industries Pte Ltd is a leading technology solutions provider headquartered in Singapore. Founded in 2015, the company has grown to become a significant player in the enterprise software market across Southeast Asia.',
    },
    {
      type: 'paragraph',
      text: 'The company specializes in **cloud infrastructure**, *data analytics*, and ***enterprise security solutions***. Their flagship product, CloudSync Pro, serves over 500 enterprise clients globally.',
    },

    // 2.0 Market Analysis
    {
      type: 'heading1',
      text: '2.0 Market Analysis',
    },
    {
      type: 'paragraph',
      text: 'The Southeast Asian enterprise software market presents significant growth opportunities:',
    },
    {
      type: 'bullet_list',
      items: [
        'Total addressable market (TAM) of USD 45 billion by 2028',
        'Cloud adoption rate growing at 25% CAGR',
        'Enterprise security spending increased 40% YoY',
        'Digital transformation initiatives driving demand',
        'Government support for technology sector development',
      ],
    },

    // 2.1 Competitive Landscape
    {
      type: 'heading2',
      text: '2.1 Competitive Landscape',
    },
    {
      type: 'paragraph',
      text: 'TechCorp competes with both global players and regional specialists. Key differentiators include local market expertise and regulatory compliance capabilities.',
    },

    // 3.0 Financial Summary
    {
      type: 'heading1',
      text: '3.0 Financial Summary',
    },
    {
      type: 'paragraph',
      text: 'The company has demonstrated strong financial performance over the past three fiscal years:',
    },
    {
      type: 'table',
      columnWidths: [40, 20, 20, 20],
      data: {
        headers: ['Metric', 'FY2023', 'FY2024', 'FY2025E'],
        rows: [
          ['Revenue (USD M)', '45.2', '62.8', '85.0'],
          ['Gross Margin (%)', '68%', '71%', '73%'],
          ['EBITDA (USD M)', '8.5', '14.2', '21.0'],
          ['EBITDA Margin (%)', '19%', '23%', '25%'],
          ['Net Income (USD M)', '4.2', '8.5', '13.0'],
          ['Headcount', '180', '245', '320'],
        ],
      },
    },

    // 3.1 Revenue Breakdown
    {
      type: 'heading2',
      text: '3.1 Revenue Breakdown by Segment',
    },
    {
      type: 'table',
      columnWidths: [50, 25, 25],
      data: {
        headers: ['Segment', 'Revenue (USD M)', '% of Total'],
        rows: [
          ['Cloud Services', '35.0', '56%'],
          ['Professional Services', '18.5', '29%'],
          ['License & Support', '9.3', '15%'],
        ],
      },
    },

    // 4.0 Key Risks
    {
      type: 'heading1',
      text: '4.0 Key Risks',
    },
    {
      type: 'paragraph',
      text: 'The following risk factors should be considered in the investment decision:',
    },

    // 4.1 Operational Risks
    {
      type: 'heading2',
      text: '4.1 Operational Risks',
    },
    {
      type: 'numbered_list',
      items: [
        'Customer concentration: Top 5 clients represent 35% of revenue',
        'Key person dependency on founding team for major client relationships',
        'Talent retention challenges in competitive Singapore market',
        'Technology obsolescence requiring continuous R&D investment',
      ],
    },

    // 4.2 Market Risks
    {
      type: 'heading2',
      text: '4.2 Market Risks',
    },
    {
      type: 'numbered_list',
      items: [
        'Increasing competition from global cloud providers (AWS, Azure, GCP)',
        'Regulatory changes in data sovereignty requirements',
        'Economic slowdown impact on enterprise IT budgets',
        'Currency fluctuation exposure across ASEAN markets',
      ],
    },

    // Divider (new feature)
    {
      type: 'divider',
    },

    // 5.0 Management Assessment
    {
      type: 'heading1',
      text: '5.0 Management Assessment',
    },

    // Quote/blockquote (new feature)
    {
      type: 'quote',
      text: '"The management team has demonstrated strong execution capabilities and deep industry knowledge. Their track record of successful enterprise deployments positions the company well for continued growth."',
    },

    {
      type: 'paragraph',
      text: 'The leadership team comprises experienced professionals with an average tenure of 8 years in the technology sector.',
    },

    // 5.1 Key Personnel
    {
      type: 'heading3',
      text: '5.1 Key Personnel',
    },
    {
      type: 'table',
      columnWidths: [25, 25, 50],
      data: {
        headers: ['Name', 'Position', 'Background'],
        rows: [
          ['John Chen', 'CEO & Co-founder', '15 years at Microsoft, Stanford MBA'],
          ['Sarah Lim', 'CTO & Co-founder', 'Former Google Cloud architect, MIT PhD'],
          ['Michael Tan', 'CFO', 'Ex-Goldman Sachs, CPA Singapore'],
          ['Lisa Wong', 'COO', '12 years at Accenture, INSEAD MBA'],
        ],
      },
    },

    // Another divider
    {
      type: 'hr',
    },

    // 6.0 Investment Recommendation
    {
      type: 'heading1',
      text: '6.0 Investment Recommendation',
    },
    {
      type: 'paragraph',
      text: 'Based on our comprehensive due diligence review, we recommend proceeding with the investment subject to the following conditions:',
    },
    {
      type: 'bullet_list',
      items: [
        'Completion of detailed technical due diligence',
        'Negotiation of key employee retention agreements',
        'Review and approval of final valuation terms',
        'Satisfactory legal review of customer contracts',
      ],
    },

    // Another quote
    {
      type: 'blockquote',
      text: 'Investment Thesis: TechCorp represents a compelling opportunity to invest in a high-growth enterprise software platform with strong regional positioning and experienced management.',
    },

    {
      type: 'paragraph',
      text: 'For more information, visit the company website at [TechCorp Industries](https://techcorp.example.com) or contact the investor relations team.',
    },
  ],
};

async function runTest() {
  console.log('='.repeat(60));
  console.log('LOCAL DOCX GENERATION TEST');
  console.log('='.repeat(60));

  try {
    console.log('\n1. Generating DOCX from sample report...');
    const buffer = await generateDocx(sampleReport);

    console.log(`   Generated buffer: ${buffer.length} bytes`);

    // Save to Downloads folder
    const outputPath = '/mnt/c/Users/User/Downloads/test-dd-output.docx';
    fs.writeFileSync(outputPath, buffer);
    console.log(`\n2. Saved to: ${outputPath}`);

    // Also save locally for reference
    const localPath = path.join(__dirname, 'test-dd-output.docx');
    fs.writeFileSync(localPath, buffer);
    console.log(`   Also saved to: ${localPath}`);

    console.log('\n' + '='.repeat(60));
    console.log('TEST COMPLETE - Please review the generated DOCX');
    console.log('='.repeat(60));

    console.log('\n📋 Verification Checklist:');
    console.log('─'.repeat(50));
    console.log('[ ] Cover page: Centered, 200pt offset, 20pt title');
    console.log('[ ] Fonts: Segoe UI 10pt throughout');
    console.log('[ ] H1 color: #365F91 (bold)');
    console.log('[ ] H2/H3 color: #4F81BD (bold)');
    console.log('[ ] Table header: #C6D9F1 background');
    console.log('[ ] Table rows: Alternating white/#C6D9F1');
    console.log('[ ] Bullet indent: 36pt');
    console.log('[ ] Quote style: Italic, gray (#666666), 36pt indent');
    console.log('[ ] Divider: Gray horizontal line');
    console.log('[ ] Page numbers: Centered, starting from page 2');
    console.log('[ ] Inline formatting: **bold**, *italic*, ***bold-italic***');
    console.log('[ ] Hyperlinks: Blue underlined text');
    console.log('─'.repeat(50));

    console.log('\n📁 Open in Word:');
    console.log(`   ${outputPath}`);

    return { success: true, path: outputPath };
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    return { success: false, error: error.message };
  }
}

// Run test
runTest().then((result) => {
  process.exit(result.success ? 0 : 1);
});
