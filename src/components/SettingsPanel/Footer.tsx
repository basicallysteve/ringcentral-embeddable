import type { FunctionComponent } from 'react';
import React from 'react';

import { styled, RcText, RcLink, RcIcon } from '@ringcentral/juno';
import { Download } from '@ringcentral/juno-icon';
import { Eula } from '@ringcentral-integration/widgets/components/Eula';
import Line from '@ringcentral-integration/widgets/components/Line';
import type { FooterProps } from '@ringcentral-integration/widgets/components/SettingsPanel/SettingsPanel.interface';
import { LogoutItem } from './SettingItem';
import i18n from './i18n';
import { downloadHar } from '../../lib/HarRecorder';

const StyledSection = styled.section`
  padding-top: 8px;
`;

const StyledDownloadLink = styled(RcLink)`
  display: inline-flex;
  align-items: center;
  gap: 4px;
`;

const StyledVersionContainer = styled(RcText)`
  padding: 10px 16px;
  font-size: 0.815rem;
`;

interface NewFooterProps extends FooterProps {
  ringSenseLicensed: boolean;
  ringCXLicensed: boolean;
  isAdmin: boolean;
}

export const Footer: FunctionComponent<NewFooterProps> = ({
  loginNumber,
  currentLocale,
  version,
  versionContainer,
  onLogoutButtonClick,
  eulaLabel,
  eulaLink,
  onEulaLinkClick,
  ringSenseLicensed,
  ringCXLicensed,
  isAdmin,
}) => {
  const versionArea = versionContainer || (
    <StyledVersionContainer
      data-sign="version"
      color="neutral.f04"
    >
      {i18n.getString('version', currentLocale)} {version}
    </StyledVersionContainer>
  );
  return (
    <>
      <StyledSection>
        <Line noBorder>
          <Eula
            dataSign="eula"
            currentLocale={currentLocale}
            link={eulaLink}
            label={eulaLabel}
            onClick={onEulaLinkClick}
          />
        </Line>
      </StyledSection>
      <StyledSection>
        <LogoutItem
          onLogout={onLogoutButtonClick}
          loginNumber={loginNumber}
          currentLocale={currentLocale}
          ringSenseLicensed={ringSenseLicensed}
          ringCXLicensed={ringCXLicensed}
          isAdmin={isAdmin}
        />
      </StyledSection>
      <StyledSection>
        <Line noBorder>
          <StyledDownloadLink
            color="content.brand"
            variant="inherit"
            data-sign="downloadHar"
            href="#"
            onClick={(e: React.MouseEvent) => {
              e.preventDefault();
              downloadHar();
            }}
          >
            <RcIcon symbol={Download} size="small" />
            {i18n.getString('downloadHar', currentLocale)}
          </StyledDownloadLink>
        </Line>
      </StyledSection>
      {versionArea}
    </>
  );
};
