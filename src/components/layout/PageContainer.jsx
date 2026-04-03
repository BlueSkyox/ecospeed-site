const PageContainer = ({ children, className = "" }) => {
  return <main className={`page-container ${className}`.trim()}>{children}</main>;
};

export default PageContainer;
